"""Azaad-1: the AzaadAI cloud model on Modal.

Qwen3.5-9B served by vLLM (FP8 weights, text-only, multi-token prediction for
speed) behind a small OpenAI-compatible gateway that builds the Bunga Azaadi
library at boot and grounds every request in it.

    modal deploy server/azaad1.py

Clients that already attach library excerpts (the AzaadAI site does) are passed
straight through. Plain API callers get server-side retrieval, so
`{"model": "azaad-1", "messages": [...]}` is grounded with no extra work.
"""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
import time
import urllib.parse
from collections import Counter, defaultdict
from pathlib import Path

import modal

BASE_MODEL = "Qwen/Qwen3.5-9B"
SERVED_NAME = "azaad-1"
VLLM_PORT = 8001
MAX_LEN = 32768
PROMPTS = Path(__file__).resolve().parent.parent / "prompts"

image = (
    modal.Image.from_registry("nvidia/cuda:12.8.1-devel-ubuntu22.04", add_python="3.12")
    .entrypoint([])
    .uv_pip_install("vllm==0.32.0", "huggingface_hub[hf_transfer]", "fastapi", "httpx", "pypdf")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1", "VLLM_USE_V1": "1"})
    .add_local_dir(str(PROMPTS), "/prompts")
)

hf_cache = modal.Volume.from_name("azaad1-hf-cache", create_if_missing=True)
vllm_cache = modal.Volume.from_name("azaad1-vllm-cache", create_if_missing=True)

app = modal.App("azaad-1")

ALLOWED_ORIGINS = [
    "https://sehajr-singhs.github.io",
    "http://localhost:5173",
    "http://localhost:4173",
]

# ---------------------------------------------------------------------------
# Library (mirrors src/lib/library.ts)
# ---------------------------------------------------------------------------

SITE_UID = "8a12b61764a2b0b075c408ab3423a91e"
HOST = "https://publish-01.obsidian.md"
DYP_PDF = "img/Dharam_Yudh_Pipeline_Whitepaper.pdf"
CORE = [r"Azadist Manifesto/", r"Khalistan Vs Khalsa Raaj", r"The Khalsa Is The Guru", r"Dharam Yudh Pipeline", r"Azadism in 500 Words"]
STOP = set(
    "a an and are as at be but by for from has have he her his i if in into is it its of on or our she so than that the their them then "
    "there these they this to was we were what when which who why will with you your not do does did can could should would about how "
    "all any more most also just only over such".split()
)


def public_url(path: str) -> str:
    parts = [urllib.parse.quote(p).replace("%20", "+") for p in path.removesuffix(".md").split("/")]
    return "https://bungaazaadi.com/" + "/".join(parts)


def clean_markdown(md: str) -> str:
    md = re.sub(r"^---\n.*?\n---\n", "", md, flags=re.S)
    md = re.sub(r"!\[\[[^\]]*\]\]", "", md)
    md = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", md)
    md = re.sub(r"\[\[([^\]|]+)\|([^\]]+)\]\]", r"\2", md)
    md = re.sub(r"\[\[([^\]]+)\]\]", lambda m: re.sub(r"#.*", "", m.group(1).split("/")[-1]), md)
    md = re.sub(r"\[([^\]]+)\]\((?:https?:)?[^)]*\)", r"\1", md)
    md = re.sub(r"<[^>]+>", "", md)
    md = re.sub(r"^>\s*\[!\w+\][+-]?\s*", "> ", md, flags=re.M)
    return re.sub(r"\n{3,}", "\n\n", md).strip()


def chunk_doc(text: str, title: str, max_chunk: int = 1400) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    heading, buf = title, ""

    def flush():
        nonlocal buf
        if len(buf.strip()) > 40:
            out.append((heading, buf.strip()))
        buf = ""

    for para in re.split(r"\n\s*\n", text):
        h = re.match(r"^#{1,4}\s+(.+)", para)
        if h:
            flush()
            heading = re.sub(r"[*_`]", "", h.group(1)).strip()
            buf = para[h.end():].strip()
            continue
        if len(buf) + len(para) > max_chunk:
            flush()
        if len(para) > max_chunk:
            for s in re.findall(r"[^.!?]+[.!?]+[\"')\]]*\s*|[^.!?]+$", para) or [para]:
                if len(buf) + len(s) > max_chunk:
                    flush()
                buf += s
        else:
            buf += ("\n\n" if buf else "") + para
    flush()
    return out


def despace(text: str, vocab: Counter) -> str:
    def freq(w: str) -> int:
        return 10**6 if w in ("a", "i") else vocab.get(w, 0)

    lines = []
    for line in text.split("\n"):
        toks, out, i = line.split(" "), [], 0
        while i < len(toks):
            for k in range(min(5, len(toks) - i), 1, -1):
                parts = toks[i : i + k]
                core = re.sub(r"[^a-z']", "", "".join(parts).lower())
                f = freq(core)
                cores = [re.sub(r"[^a-z']", "", p.lower()) for p in parts]
                if len(core) >= 2 and f and all(cores) and min(map(freq, cores)) < f:
                    out.append("".join(parts))
                    i += k
                    break
            else:
                out.append(toks[i])
                i += 1
        lines.append(" ".join(out))
    return "\n".join(lines)


def stem(t: str) -> str:
    if len(t) > 5 and t.endswith("ing"):
        return t[:-3]
    if len(t) > 4 and t.endswith("ies"):
        return t[:-3] + "y"
    if len(t) > 3 and t.endswith("s") and not t.endswith("ss"):
        return t[:-1]
    return t


def tokenize(s: str) -> list[str]:
    return [stem(t) for t in re.split(r"[^a-z0-9਀-੿]+", s.lower()) if len(t) > 1 and t not in STOP]


class Library:
    def __init__(self):
        self.docs: list[dict] = []
        self.chunks: list[tuple[int, str, str]] = []
        self.tf: list[Counter] = []
        self.df: Counter = Counter()
        self.avg = 1.0

    def load(self):
        import httpx
        from pypdf import PdfReader

        with httpx.Client(timeout=60, follow_redirects=True) as http:
            index = http.get(f"{HOST}/cache/{SITE_UID}").json()
            vocab: Counter = Counter({"dyp": 50})
            for path in [p for p in index if p.endswith(".md")]:
                try:
                    r = http.get(f"{HOST}/access/{SITE_UID}/{urllib.parse.quote(path)}")
                    r.raise_for_status()
                except Exception as exc:  # noqa: BLE001
                    print("skip", path, exc)
                    continue
                text = clean_markdown(r.text)
                if len(text) < 120:
                    continue
                vocab.update(re.findall(r"[a-z']{2,}", text.lower()))
                title = re.sub(r"^\d+\s+", "", path.split("/")[-1].removesuffix(".md"))
                self._add(path, title, public_url(path), text)
            try:
                pdf = http.get(f"{HOST}/access/{SITE_UID}/{urllib.parse.quote(DYP_PDF)}").content
                tmp = Path("/tmp/dyp.pdf")
                tmp.write_bytes(pdf)
                raw = "\n".join(p.extract_text() or "" for p in PdfReader(tmp).pages)
                raw = "\n".join(l for l in raw.split("\n") if "Whitepaper Published by Bunga Azaadi" not in l)
                self._add(
                    "Khalsa Revival/Dharam Yudh Pipeline/Dharam Yudh Pipeline Whitepaper.md",
                    "The Dharam Yudh Pipeline (Whitepaper)",
                    public_url("Khalsa Revival/Dharam Yudh Pipeline/Dharam Yudh Pipeline.md"),
                    despace(re.sub(r"[ \t]+", " ", raw), vocab),
                )
            except Exception as exc:  # noqa: BLE001
                print("DYP whitepaper unavailable", exc)
        self.avg = sum(sum(c.values()) for c in self.tf) / max(1, len(self.tf))
        print(f"library: {len(self.docs)} docs, {len(self.chunks)} chunks")

    def _add(self, path: str, title: str, url: str, text: str):
        d = len(self.docs)
        self.docs.append({"path": path, "title": title, "url": url, "core": any(re.search(c, path) for c in CORE)})
        for heading, body in chunk_doc(text, title):
            toks = tokenize(body) + tokenize(f"{title} {heading}") * 2
            c = Counter(toks)
            self.df.update(c.keys())
            self.tf.append(c)
            self.chunks.append((d, heading, body))

    def search(self, query: str, k: int = 10, max_per_doc: int = 3) -> list[tuple[int, float]]:
        q = set(tokenize(query))
        n = len(self.tf)
        scored = []
        for i, tf in enumerate(self.tf):
            s = 0.0
            ln = sum(tf.values())
            for t in q:
                f = tf.get(t)
                if f:
                    df = self.df[t]
                    idf = math.log(1 + (n - df + 0.5) / (df + 0.5))
                    s += idf * f * 2.4 / (f + 1.4 * (0.28 + 0.72 * ln / self.avg))
            if s > 0:
                if self.docs[self.chunks[i][0]]["core"]:
                    s *= 1.15
                scored.append((s, i))
        scored.sort(reverse=True)
        per_doc: dict[int, int] = defaultdict(int)
        hits = []
        for s, i in scored:
            d = self.chunks[i][0]
            if per_doc[d] >= max_per_doc:
                continue
            per_doc[d] += 1
            hits.append((i, s))
            if len(hits) >= k:
                break
        return hits

    def excerpts(self, hits, budget: int = 14000) -> tuple[str, list[dict]]:
        out, sources = "", []
        for n, (i, _) in enumerate(hits, 1):
            d, heading, body = self.chunks[i]
            doc = self.docs[d]
            block = f"[{n}] {doc['title']}{f' > {heading}' if heading != doc['title'] else ''}\n{body}\n\n"
            if len(out) + len(block) > budget and n > 1:
                break
            out += block
            sources.append({"n": n, "title": doc["title"], "heading": heading if heading != doc["title"] else "", "url": doc["url"], "core": doc["core"]})
        return out.strip(), sources


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


@app.cls(
    image=image,
    gpu="L4",
    volumes={"/root/.cache/huggingface": hf_cache, "/root/.cache/vllm": vllm_cache},
    scaledown_window=300,
    timeout=600,
    max_containers=1,  # caps spend: one GPU, no matter the traffic
    min_containers=0,
)
@modal.concurrent(max_inputs=24)
class Azaad1:
    @modal.enter()
    def start(self):
        self.persona = Path("/prompts/azaad.md").read_text(encoding="utf-8")
        self.council = Path("/prompts/council.md").read_text(encoding="utf-8")
        cmd = [
            "vllm", "serve", BASE_MODEL,
            "--served-model-name", SERVED_NAME,
            "--host", "127.0.0.1", "--port", str(VLLM_PORT),
            "--quantization", "fp8",
            "--language-model-only",
            "--max-model-len", str(MAX_LEN),
            "--gpu-memory-utilization", "0.92",
            "--enable-prefix-caching",
            "--reasoning-parser", "qwen3",
            "--speculative-config", json.dumps({"method": "qwen3_next_mtp", "num_speculative_tokens": 2}),
        ]
        self.proc = subprocess.Popen(cmd)
        self.library = Library()
        self.library.load()  # overlaps with vLLM boot
        import httpx

        deadline = time.time() + 540
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError("vLLM exited during startup")
            try:
                if httpx.get(f"http://127.0.0.1:{VLLM_PORT}/health", timeout=2).status_code == 200:
                    break
            except Exception:  # noqa: BLE001
                pass
            time.sleep(2)
        hf_cache.commit()
        vllm_cache.commit()
        self.hits: dict[str, list[float]] = defaultdict(list)

    @modal.exit()
    def stop(self):
        self.proc.terminate()

    def _rate_ok(self, ip: str, limit: int = 30, window: float = 600) -> bool:
        now = time.time()
        q = [t for t in self.hits[ip] if now - t < window]
        q.append(now)
        self.hits[ip] = q
        return len(q) <= limit

    @modal.asgi_app()
    def web(self):
        import httpx
        from fastapi import FastAPI, Request
        from fastapi.middleware.cors import CORSMiddleware
        from fastapi.responses import JSONResponse, StreamingResponse

        api = FastAPI(title="Azaad-1", version="1.0")
        api.add_middleware(
            CORSMiddleware,
            allow_origins=ALLOWED_ORIGINS,
            allow_origin_regex=r"https://.*\.github\.io",
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["*"],
        )
        client = httpx.AsyncClient(base_url=f"http://127.0.0.1:{VLLM_PORT}", timeout=httpx.Timeout(300, connect=10))

        @api.get("/health")
        async def health():
            return {"status": "ok", "model": SERVED_NAME, "base": BASE_MODEL, "docs": len(self.library.docs), "chunks": len(self.library.chunks)}

        @api.get("/v1/models")
        async def models():
            return {"object": "list", "data": [{"id": SERVED_NAME, "object": "model", "created": 0, "owned_by": "azaadai"}]}

        @api.get("/v1/library/search")
        async def search(q: str, k: int = 8):
            text, sources = self.library.excerpts(self.library.search(q, min(k, 20)))
            return {"sources": sources, "excerpts": text}

        @api.post("/v1/chat/completions")
        async def chat(request: Request):
            ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "?").split(",")[0].strip()
            if not self._rate_ok(ip):
                return JSONResponse({"error": {"message": "Rate limit: 30 messages per 10 minutes. Try again shortly, or bring your own key."}}, 429)
            body = await request.json()
            msgs = [m for m in body.get("messages", []) if m.get("role") in ("system", "user", "assistant") and isinstance(m.get("content"), str)]
            if not any(m["role"] == "user" for m in msgs):
                return JSONResponse({"error": {"message": "Need at least one user message."}}, 400)

            system = "\n\n".join(m["content"] for m in msgs if m["role"] == "system")
            convo = [m for m in msgs if m["role"] != "system"][-12:]
            sources: list[dict] = []
            if "LIBRARY EXCERPTS" not in system:
                # Plain API caller: ground the request ourselves.
                users = [m["content"] for m in convo if m["role"] == "user"]
                council = bool(body.get("council")) or "--council" in users[-1]
                excerpts, sources = self.library.excerpts(self.library.search(" ".join(users[-2:] + users[-1:])))
                system = f"{self.persona}\n\n{self.council + chr(10) * 2 if council else ''}## LIBRARY EXCERPTS\n\n{excerpts}" + (f"\n\n{system}" if system else "")

            payload = {
                "model": SERVED_NAME,
                "messages": [{"role": "system", "content": system}, *convo],
                "stream": bool(body.get("stream", True)),
                "max_tokens": min(int(body.get("max_tokens") or 2048), 4096),
                "temperature": body.get("temperature", 0.7),
                "top_p": 0.8,
                "top_k": 20,
                "presence_penalty": 1.0,
                "chat_template_kwargs": {"enable_thinking": False},
            }
            if not payload["stream"]:
                r = await client.post("/v1/chat/completions", json=payload)
                data = r.json()
                if sources:
                    data["azaad_sources"] = sources
                return JSONResponse(data, r.status_code)

            async def stream():
                if sources:
                    yield f"data: {json.dumps({'object': 'chat.completion.chunk', 'choices': [], 'azaad_sources': sources})}\n\n"
                async with client.stream("POST", "/v1/chat/completions", json=payload) as r:
                    if r.status_code != 200:
                        err = (await r.aread()).decode(errors="replace")[:500]
                        yield f"data: {json.dumps({'error': {'message': f'Model error {r.status_code}: {err}'}})}\n\n"
                        yield "data: [DONE]\n\n"
                        return
                    async for line in r.aiter_lines():
                        if line:
                            yield line + "\n\n"

            return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

        return api
