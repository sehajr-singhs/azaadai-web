"""Azaad: Bunga Azaadi's model, served through a small gateway on Modal.

The model is Gemma 4 31B with LoRA adapters trained on the Institute's work,
running on a RunPod Serverless GPU endpoint that scales to zero. This gateway
is the only thing that holds the RunPod key. It also:

  - keeps the library index and does retrieval (public tier: the four core
    papers; research tier: the whole Vichaar Repository)
  - runs the research loop (plan -> search -> reflect -> search -> answer) and
    streams every step as a trace, alongside the model's own reasoning
  - checks access codes for the internal research tier
  - rate-limits

    modal deploy server/azaad1.py

Secrets (Modal):
  azaad-runpod   RUNPOD_API_KEY, RUNPOD_ENDPOINT_ID
  azaad-access   AZAAD_ACCESS_CODES = "group:code,group2:code2"
"""

import asyncio
import hmac
import json
import os
import re
import time
from collections import defaultdict
from pathlib import Path

import modal

import azaad_lib as L

PROMPTS = Path(__file__).resolve().parent.parent / "prompts"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install("fastapi[standard]", "httpx", "pypdf")
    .add_local_dir(str(PROMPTS), "/prompts")
    .add_local_python_source("azaad_lib")
)
library_cache = modal.Volume.from_name("azaad1-library", create_if_missing=True)
LIBRARY_FILE = Path("/library/docs.v2.json")

app = modal.App("azaad")

PUBLIC_MODEL = "azaad"            # LoRA trained on the four core papers
RESEARCH_MODEL = "azaad-research"  # LoRA trained on the whole repository
BASE_MODEL = "google/gemma-4-31B-it"  # used for planning steps

ALLOWED_ORIGINS = ["https://sehajr-singhs.github.io", "http://localhost:5173", "http://localhost:4173"]

TIERS = {
    "public": {"model": PUBLIC_MODEL, "queries": 4, "hits": 10, "budget": 13000, "max_tokens": 3000, "rounds": 2, "limit": 40},
    "research": {"model": RESEARCH_MODEL, "queries": 6, "hits": 18, "budget": 26000, "max_tokens": 5000, "rounds": 2, "limit": 300},
}

PLAN_PROMPT = """You plan library searches for Bunga Azaadi's model. The library is {scope}.

Conversation so far (most recent last):
{convo}

Return JSON only: {{"intent": "<what the person really wants, one short line>", "queries": ["<search query>", ...]}}
Write up to {n} short keyword-style queries that would find the passages needed, covering different angles (definitions, the argument, objections, application). Use the Institute's own vocabulary where it fits (Khalsa Raaj, Miri-Piri, NAP, Misl, Sarbat Khalsa, DYP, Stanistan...)."""

REFLECT_PROMPT = """You are checking research coverage for this question:
{question}

Passages found so far (titles and opening lines):
{found}

Return JSON only: {{"gaps": ["<what is still missing>", ...], "queries": ["<search query>", ...]}}
Name up to 3 gaps and up to 3 new queries to fill them. If coverage is already complete, return empty lists."""

PLAN_SCHEMA = {"type": "object", "properties": {"intent": {"type": "string"}, "queries": {"type": "array", "items": {"type": "string"}}}, "required": ["intent", "queries"]}
REFLECT_SCHEMA = {"type": "object", "properties": {"gaps": {"type": "array", "items": {"type": "string"}}, "queries": {"type": "array", "items": {"type": "string"}}}, "required": ["gaps", "queries"]}


def fuse(lib: L.Library, queries: list[str], k: int, per_query: int = 8, exclude: set[int] | None = None) -> tuple[list[int], list[dict]]:
    """Reciprocal-rank fusion over several queries. Returns chunk ids and a per-query report."""
    score: dict[int, float] = defaultdict(float)
    report = []
    for q in queries:
        hits = lib.search(q, per_query, exclude=exclude)
        for rank, (i, _) in enumerate(hits):
            score[i] += 1 / (60 + rank)
        found = []
        for i, _ in hits[:4]:
            d, heading, _body = lib.chunks[i]
            title = lib.docs[d]["title"]
            found.append(f"{title} › {heading}" if heading and heading != title else title)
        report.append({"query": q, "found": list(dict.fromkeys(found))})
    ids = sorted(score, key=score.get, reverse=True)[:k]
    return ids, report


@app.cls(image=image, secrets=[modal.Secret.from_name("azaad-runpod"), modal.Secret.from_name("azaad-access")],
         volumes={"/library": library_cache}, cpu=1.0, memory=1536, scaledown_window=900, timeout=900, max_containers=2)
@modal.concurrent(max_inputs=64)
class Gateway:
    @modal.enter()
    def start(self):
        self.persona = Path("/prompts/azaad.md").read_text(encoding="utf-8")
        self.council = Path("/prompts/council.md").read_text(encoding="utf-8")
        docs, fresh = L.load_docs(cache=LIBRARY_FILE)
        if fresh:
            library_cache.commit()
        self.libs = {"public": L.Library(docs, public_only=True), "research": L.Library(docs)}
        self.hits: dict[str, list[float]] = defaultdict(list)
        self.codes = {}
        for pair in os.environ.get("AZAAD_ACCESS_CODES", "").split(","):
            if ":" in pair:
                group, code = pair.split(":", 1)
                self.codes[code.strip()] = group.strip()
        self.runpod = f"https://api.runpod.ai/v2/{os.environ['RUNPOD_ENDPOINT_ID']}"
        self.key = os.environ["RUNPOD_API_KEY"]
        self.last_use = 0.0

    def _group(self, code: str | None) -> str | None:
        if not code:
            return None
        for known, group in self.codes.items():
            if hmac.compare_digest(known.encode(), code.strip().encode()):
                return group
        return None

    def _rate_ok(self, who: str, limit: int, window: float = 600) -> bool:
        now = time.time()
        q = [t for t in self.hits[who] if now - t < window]
        q.append(now)
        self.hits[who] = q
        return len(q) <= limit

    @modal.asgi_app()
    def web(self):
        import httpx
        from fastapi import FastAPI, Request
        from fastapi.middleware.cors import CORSMiddleware
        from fastapi.responses import JSONResponse, StreamingResponse

        api = FastAPI(title="Azaad", version="2.0")
        api.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_origin_regex=r"https://.*\.github\.io",
                           allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["*"])
        client = httpx.AsyncClient(timeout=httpx.Timeout(600, connect=20))
        auth = {"authorization": f"Bearer {self.key}"}

        async def complete(model: str, messages: list, schema: dict | None = None, max_tokens: int = 400) -> str:
            body = {"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": 0.2,
                    "chat_template_kwargs": {"enable_thinking": False}}
            if schema:
                body["response_format"] = {"type": "json_schema", "json_schema": {"name": "out", "schema": schema}}
            r = await client.post(f"{self.runpod}/openai/v1/chat/completions", json=body, headers=auth)
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"] or ""

        def up(w: dict) -> int:
            return w.get("idle", 0) + w.get("running", 0) + w.get("ready", 0)

        async def workers() -> dict:
            r = await client.get(f"{self.runpod}/health", headers=auth, timeout=10)
            return r.json().get("workers", {})

        async def kick():
            """Queue a one-token request so RunPod starts a worker."""
            try:
                await complete(PUBLIC_MODEL, [{"role": "user", "content": "Sat Sri Akaal"}], max_tokens=1)
            except Exception:  # noqa: BLE001
                pass

        def tier_of(request: Request, body: dict | None = None) -> tuple[str, str | None]:
            group = self._group(request.headers.get("x-azaad-access"))
            wants = (body or {}).get("mode") or request.query_params.get("mode")
            if group and wants != "public":
                return "research", group
            return "public", group

        @api.get("/health")
        async def health():
            return {"status": "ok", "model": PUBLIC_MODEL, "docs": {k: len(v.docs) for k, v in self.libs.items()},
                    "chunks": {k: len(v.chunks) for k, v in self.libs.items()}}

        @api.get("/v1/status")
        async def status():
            """Whether a GPU worker is warm. The site shows 'waking up' when it isn't."""
            try:
                w = await workers()
                return {"warm": up(w) > 0, "starting": w.get("initializing", 0) > 0, "workers": w}
            except Exception as exc:  # noqa: BLE001
                return {"warm": False, "starting": False, "error": exc.__class__.__name__}

        @api.post("/v1/warm")
        async def warm():
            """Start a worker in the background so the first question doesn't wait for a cold boot."""
            if time.time() - self.last_use > 60:
                self.last_use = time.time()
                asyncio.create_task(kick())
            return {"ok": True}

        @api.post("/v1/access")
        async def access(request: Request):
            body = await request.json()
            ip = request.headers.get("x-forwarded-for", "?").split(",")[0].strip()
            if not self._rate_ok(f"access:{ip}", 10):
                return JSONResponse({"error": {"message": "Too many attempts. Wait ten minutes."}}, 429)
            group = self._group(body.get("code"))
            if not group:
                return JSONResponse({"error": {"message": "That code isn't valid."}}, 403)
            return {"ok": True, "tier": "research", "group": group}

        @api.get("/v1/models")
        async def models():
            return {"object": "list", "data": [{"id": m, "object": "model", "created": 0, "owned_by": "bunga-azaadi"} for m in (PUBLIC_MODEL, RESEARCH_MODEL)]}

        @api.get("/v1/library/search")
        async def search(request: Request, q: str, k: int = 8):
            tier, _ = tier_of(request)
            lib = self.libs[tier]
            ids = [i for i, _ in lib.search(q, min(k, 24))]
            text, sources = lib.excerpts(ids, TIERS[tier]["budget"])
            return {"tier": tier, "sources": sources, "excerpts": text}

        @api.post("/v1/chat/completions")
        async def chat(request: Request):
            body = await request.json()
            tier, group = tier_of(request, body)
            cfg = TIERS[tier]
            ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "?").split(",")[0].strip()
            if not self._rate_ok(group or ip, cfg["limit"]):
                return JSONResponse({"error": {"message": f"Rate limit: {cfg['limit']} messages per 10 minutes."}}, 429)
            msgs = [m for m in body.get("messages", []) if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)][-12:]
            if not msgs or msgs[-1]["role"] != "user":
                return JSONResponse({"error": {"message": "The last message must be from the user."}}, 400)
            council = bool(body.get("council"))
            question = msgs[-1]["content"]
            lib = self.libs[tier]
            self.last_use = time.time()

            async def run():
                t0 = time.time()

                def ev(**kw):
                    return {"object": "chat.completion.chunk", "model": cfg["model"], "choices": [], **kw}

                def trace(step, title, **detail):
                    return ev(azaad_trace={"step": step, "title": title, "ms": int((time.time() - t0) * 1000), **detail})

                yield ev(azaad_meta={"tier": tier, "model": cfg["model"], "council": council})

                # 0. Make sure a GPU worker is up; a cold boot takes a minute or two.
                try:
                    w = await workers()
                    if not up(w):
                        yield trace("wake", "Waking the model", detail="The GPU sleeps when no one is asking. First answer after a quiet spell takes a minute or two.")
                        waker = asyncio.create_task(kick())
                        for _ in range(100):
                            await asyncio.sleep(3)
                            w = await workers()
                            if up(w):
                                break
                        waker.cancel()
                        yield trace("wake", "Model is awake")
                except Exception:  # noqa: BLE001
                    pass  # health check unavailable; the calls below will wait in RunPod's queue

                # 1. Plan
                convo = "\n".join(f"{m['role'].upper()}: {m['content'][:600]}" for m in msgs[-5:])
                scope = "the four core papers of Bunga Azaadi" if tier == "public" else "the whole Bunga Azaadi Vichaar Repository"
                yield trace("plan", "Reading the question")
                try:
                    plan = json.loads(await complete(BASE_MODEL, [{"role": "user", "content": PLAN_PROMPT.format(scope=scope, convo=convo, n=cfg["queries"])}], PLAN_SCHEMA))
                    queries = [q for q in plan.get("queries", []) if q.strip()][: cfg["queries"]] or [question]
                    intent = plan.get("intent", "")
                except Exception:  # noqa: BLE001
                    queries, intent = [question], ""
                users = [m["content"] for m in msgs if m["role"] == "user"]
                queries = list(dict.fromkeys([" ".join(users[-2:])] + queries))
                yield trace("plan", "Understood the question", intent=intent, queries=queries)

                # 2. Search
                ids, report = fuse(lib, queries, cfg["hits"])
                yield trace("search", f"Searched {'the papers' if tier == 'public' else 'the repository'}", searches=report)

                # 3. Reflect and search again (research tier)
                if cfg["rounds"] > 1 and ids:
                    found = "\n".join(f"- {lib.docs[lib.chunks[i][0]]['title']}: {lib.chunks[i][2][:140]}" for i in ids)
                    try:
                        gap = json.loads(await complete(BASE_MODEL, [{"role": "user", "content": REFLECT_PROMPT.format(question=question, found=found)}], REFLECT_SCHEMA))
                    except Exception:  # noqa: BLE001
                        gap = {"gaps": [], "queries": []}
                    if gap.get("queries"):
                        more, report2 = fuse(lib, gap["queries"][:3], 8 if tier == "research" else 4, exclude=set(ids))
                        ids += more
                        yield trace("reflect", "Looked for what was missing", gaps=gap.get("gaps", []), searches=report2)

                excerpts, sources = lib.excerpts(ids, cfg["budget"])
                papers = list(dict.fromkeys(s["title"] for s in sources))
                passages = []
                for src, i in zip(sources, ids):
                    snippet = re.sub(r"\s+", " ", lib.chunks[i][2]).strip()
                    passages.append({"n": src["n"], "title": src["title"], "heading": src["heading"], "snippet": snippet[:220] + ("…" if len(snippet) > 220 else "")})
                yield trace("read", f"Reading {len(sources)} passages from {len(papers)} {'documents' if len(papers) != 1 else 'document'}", documents=papers, passages=passages)
                yield ev(azaad_sources=sources)

                # 4. Answer, streaming the model's own reasoning first
                system = f"{self.persona}\n\n{self.council if council else ''}\n\n## LIBRARY EXCERPTS\n\n{excerpts}"
                payload = {
                    "model": cfg["model"], "stream": True,
                    "messages": [{"role": "system", "content": system}, *msgs],
                    "max_tokens": min(int(body.get("max_tokens") or cfg["max_tokens"]), cfg["max_tokens"]),
                    "temperature": float(body.get("temperature", 0.7)), "top_p": 0.95,
                    "chat_template_kwargs": {"enable_thinking": True},
                }
                yield trace("reason", "Reasoning")
                answering = False
                async with client.stream("POST", f"{self.runpod}/openai/v1/chat/completions", json=payload, headers=auth) as r:
                    if r.status_code != 200:
                        raise RuntimeError(f"model returned {r.status_code}: {(await r.aread())[:300]!r}")
                    async for line in r.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                        except ValueError:
                            continue
                        delta = ((chunk.get("choices") or [{}])[0].get("delta") or {})
                        if delta.get("content") and not answering:
                            answering = True
                            yield trace("answer", "Answering")
                        chunk["model"] = cfg["model"]
                        yield chunk
                yield trace("done", "Done")

            if not body.get("stream", True):
                text, reasoning, meta = "", "", {}
                try:
                    async for e in run():
                        for k, v in e.items():
                            if k == "azaad_trace":
                                meta.setdefault(k, []).append(v)
                            elif k.startswith("azaad_"):
                                meta[k] = v
                        for ch in e.get("choices") or []:
                            d = ch.get("delta") or {}
                            text += d.get("content") or ""
                            reasoning += d.get("reasoning_content") or d.get("reasoning") or ""
                except Exception as exc:  # noqa: BLE001
                    return JSONResponse({"error": {"message": f"Azaad is unavailable: {exc}"}}, 502)
                return {"object": "chat.completion", "model": cfg["model"],
                        "choices": [{"index": 0, "message": {"role": "assistant", "content": text, "reasoning_content": reasoning}, "finish_reason": "stop"}], **meta}

            async def stream():
                try:
                    async for e in run():
                        yield f"data: {json.dumps(e)}\n\n"
                except Exception as exc:  # noqa: BLE001
                    import traceback

                    traceback.print_exc()
                    yield f"data: {json.dumps({'error': {'message': f'Azaad is unavailable right now ({exc.__class__.__name__}). Try again in a minute.'}})}\n\n"
                yield "data: [DONE]\n\n"

            return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

        return api
