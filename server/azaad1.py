"""AzaadAI: Bunga Azaadi's model, served through a small gateway on Modal.

The model is Gemma 4 31B with LoRA adapters trained on the Institute's work,
running on a RunPod Serverless GPU endpoint that scales to zero. This gateway
is the only thing that holds the RunPod key. It also:

  - keeps the library index and does retrieval (public tier: the four core
    papers; research tier: the whole Vichaar Repository)
  - runs the research loop (plan -> search -> reflect -> search -> answer) and
    streams every step as a trace, alongside the model's own reasoning
  - checks access codes for the internal research tier
  - rate-limits
  - logs every question (no names, no IPs) and has the model classify it in
    the background, for the owner's private analytics page

    modal deploy server/azaad1.py

Secrets (Modal):
  azaad-runpod   RUNPOD_API_KEY, RUNPOD_ENDPOINT_ID
  azaad-access   AZAAD_ACCESS_CODES = "group:code,group2:code2"
  azaad-owner    AZAAD_OWNER_KEY (unlocks the research tier and /v1/admin/*), AZAAD_SALT
"""

import asyncio
import hashlib
import hmac
import json
import os
import re
import time
import uuid
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
analytics = modal.Dict.from_name("azaadai-analytics", create_if_missing=True)

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
CATEGORIES = ["concept", "history", "economics", "governance-law", "sikhi-theology", "strategy-dharam-yudh",
              "comparison-critique", "personal-application", "current-events", "about-azaadai", "off-topic"]

CLASSIFY_PROMPT = """You classify questions people ask AzaadAI, Bunga Azaadi's model of the Azadist framework, so the Institute can see what people want to know.

Question: {question}
Earlier in the conversation: {context}
Papers retrieved: {papers}
Coverage check made before answering (from the passages alone): {verdict}
Start of AzaadAI's answer: {answer}

Return JSON only:
- category: one of {cats}
- topics: up to 4 short lowercase topic tags (e.g. "taxation", "sarbat khalsa", "khalistan")
- stance: the asker's apparent stance: curious, supportive, skeptical, hostile or neutral
- coverage: does Bunga Azaadi's own writing actually answer this? "covered", "partial" or "not-covered". Start from the coverage check; only override it if the answer clearly quotes the texts settling the question.
- interest: 1 to 5. 5 = a question the Institute should read: a sharp objection, a gap in the framework, a new angle, a serious real-world application, or a sign of a new audience. 1 = routine or trivial.
- why: one short line on why it is or isn't interesting
- summary: the question restated in at most 12 words"""

CLASSIFY_SCHEMA = {"type": "object", "properties": {
    "category": {"type": "string", "enum": CATEGORIES},
    "topics": {"type": "array", "items": {"type": "string"}},
    "stance": {"type": "string", "enum": ["curious", "supportive", "skeptical", "hostile", "neutral"]},
    "coverage": {"type": "string", "enum": ["covered", "partial", "not-covered"]},
    "interest": {"type": "integer"},
    "why": {"type": "string"},
    "summary": {"type": "string"},
}, "required": ["category", "topics", "stance", "coverage", "interest", "why", "summary"]}

# Appended to the system prompt. The public model only has the four papers, so it
# must say when something isn't defined there instead of implying it is.
SCOPE_RULE = {
    "public": """## SCOPE (public model)
The excerpts above come from the four core papers, and they are all you have. The framework does not define everything.
- If the question, or part of it, isn't defined in these papers, say so plainly before you answer that part, for example: "This isn't fully defined in the Azadist framework." or "The core papers don't address this directly."
- You may then reason from Azadist principles, but label it as your own extension ("Reasoning from the principles rather than the texts: ..."), never as the Institute's position.
- Never cite a passage for a claim it doesn't make, and never imply the framework already has a settled answer to everything.""",
    "research": """## SCOPE (research model)
If the repository doesn't define something, say so plainly ("The repository doesn't settle this.") before reasoning from principles, and label that reasoning as your own extension.""",
}

COVER_PROMPT = """You are a strict checker for Bunga Azaadi. Decide whether the PASSAGES below, taken from {scope}, themselves answer the question. Ignore what a clever reader could extrapolate from general principles.

Question: {question}

PASSAGES:
{excerpts}

Judge the TOPIC, not the format of the request. Requests to explain, summarise, walk through, steelman, critique, compare or apply a topic are "covered" when the passages discuss that topic; the format itself is never what is missing.

Return JSON only:
- coverage: "covered" if the passages discuss this topic and state a position on it; "partial" if a substantive part of the topic is not discussed, or the passages give only a general principle that the answer would have to extend to reach this topic; "not-covered" if the topic itself is not discussed
- missing: the part of the topic the texts do not define, as a noun phrase of at most 10 words (e.g. "a position on abortion"), or "" if covered
- defined: what the texts do define that bears on it, at most 12 words, or "" if nothing"""

COVER_SCHEMA = {"type": "object", "properties": {
    "coverage": {"type": "string", "enum": ["covered", "partial", "not-covered"]},
    "missing": {"type": "string"},
    "defined": {"type": "string"},
}, "required": ["coverage", "missing", "defined"]}

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


@app.cls(image=image, secrets=[modal.Secret.from_name("azaad-runpod"), modal.Secret.from_name("azaad-access"), modal.Secret.from_name("azaad-owner")],
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
        self.owner = os.environ.get("AZAAD_OWNER_KEY", "")
        self.salt = os.environ.get("AZAAD_SALT", "azaadai")
        self.last_use = 0.0
        self.tasks: set = set()

    def _is_owner(self, key: str | None) -> bool:
        return bool(self.owner and key and hmac.compare_digest(self.owner.encode(), key.strip().encode()))

    def _group(self, code: str | None) -> str | None:
        if not code:
            return None
        if self._is_owner(code):
            return "owner"
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

        api = FastAPI(title="AzaadAI", version="2.1")
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

        def spawn(coro):
            t = asyncio.create_task(coro)
            self.tasks.add(t)
            t.add_done_callback(self.tasks.discard)

        def visitor(request: Request) -> str:
            """A per-day pseudonym. The raw IP is never stored."""
            ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "?").split(",")[0].strip()
            day = time.strftime("%Y-%m-%d", time.gmtime())
            return hashlib.sha256(f"{self.salt}|{ip}|{day}".encode()).hexdigest()[:12]

        async def record(rec: dict):
            """Store the question, then have the model classify it. Runs after the answer, off the hot path."""
            key = rec["id"]
            try:
                await analytics.put.aio(key, rec)
            except Exception as exc:  # noqa: BLE001
                print("analytics put failed", exc)
                return
            if not rec.get("answer_head"):
                return
            try:
                raw = await complete(BASE_MODEL, [{"role": "user", "content": CLASSIFY_PROMPT.format(
                    question=rec["question"][:1500], context=rec.get("context", "")[:600] or "(none)",
                    papers=", ".join(rec.get("papers", [])[:10]) or "(none)", answer=rec.get("answer_head", "")[:1500],
                    verdict=json.dumps(rec.get("scope") or {}),
                    cats=", ".join(CATEGORIES))}], CLASSIFY_SCHEMA, max_tokens=300)
                c = json.loads(raw)
                c["interest"] = max(1, min(5, int(c.get("interest", 1))))
                c["topics"] = [t.strip().lower() for t in c.get("topics", []) if t.strip()][:4]
                rec["cls"] = c
                await analytics.put.aio(key, rec)
            except Exception as exc:  # noqa: BLE001
                print("classify failed", exc.__class__.__name__, exc)

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

        @api.get("/v1/library")
        async def library(request: Request):
            """Every document this tier can draw on, so readers can see the whole shelf."""
            tier, _ = tier_of(request)
            lib = self.libs[tier]
            counts: dict[int, int] = defaultdict(int)
            for d, _h, _b in lib.chunks:
                counts[d] += 1
            docs = [{"title": d["title"], "url": d["url"], "core": d["core"], "paper": d["paper"], "path": d["path"], "sections": counts[i]}
                    for i, d in enumerate(lib.docs)]
            return {"tier": tier, "count": len(docs), "docs": docs}

        def owner_only(request: Request):
            if not self._is_owner(request.headers.get("x-azaad-owner")):
                return JSONResponse({"error": {"message": "Owner key required."}}, 403)
            return None

        @api.get("/v1/admin/analytics")
        async def admin_analytics(request: Request, days: int = 90):
            if (deny := owner_only(request)) is not None:
                return deny
            cutoff = time.time() - days * 86400 if days > 0 else 0
            rows = []
            async for _k, v in analytics.items.aio():
                if isinstance(v, dict) and v.get("ts", 0) >= cutoff:
                    rows.append(v)
            rows.sort(key=lambda r: r.get("ts", 0), reverse=True)
            return {"count": len(rows), "rows": rows[:5000]}

        @api.post("/v1/admin/mark")
        async def admin_mark(request: Request):
            if (deny := owner_only(request)) is not None:
                return deny
            body = await request.json()
            key = str(body.get("id", ""))
            rec = await analytics.get.aio(key)
            if not rec:
                return JSONResponse({"error": {"message": "Not found."}}, 404)
            if body.get("delete"):
                await analytics.pop.aio(key)
                return {"ok": True, "deleted": True}
            if "starred" in body:
                rec["starred"] = bool(body["starred"])
            if "note" in body:
                rec["note"] = str(body["note"])[:1000]
            await analytics.put.aio(key, rec)
            return {"ok": True, "row": rec}

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

            rec = {"id": f"{int(time.time() * 1000):013d}-{uuid.uuid4().hex[:6]}", "ts": time.time(), "tier": tier,
                   "owner": group == "owner", "group": group if group and group != "owner" else None, "council": council,
                   "question": question[:4000], "turn": sum(1 for m in msgs if m["role"] == "user"),
                   "context": " | ".join(m["content"][:200] for m in msgs[:-1] if m["role"] == "user")[-600:],
                   "visitor": visitor(request), "papers": [], "sources": 0, "src": []}
            state = {"answer": "", "first": None, "error": None, "done": False}

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
                rec["papers"], rec["sources"] = papers, len(sources)
                rec["src"] = [{"n": s["n"], "title": s["title"]} for s in sources]
                passages = []
                for src, i in zip(sources, ids):
                    snippet = re.sub(r"\s+", " ", lib.chunks[i][2]).strip()
                    passages.append({"n": src["n"], "title": src["title"], "heading": src["heading"], "snippet": snippet[:220] + ("…" if len(snippet) > 220 else "")})
                yield trace("read", f"Reading {len(sources)} passages from {len(papers)} {'documents' if len(papers) != 1 else 'document'}", documents=papers, passages=passages)
                yield ev(azaad_sources=sources)

                # 3b. Check, from the passages alone, whether the texts actually settle this.
                scope_note = ""
                try:
                    verdict = json.loads(await complete(BASE_MODEL, [{"role": "user", "content": COVER_PROMPT.format(
                        scope=scope, question=" ".join(users[-2:])[:1500], excerpts=excerpts[:10000])}], COVER_SCHEMA, max_tokens=400))
                    cov = verdict.get("coverage", "covered")
                except Exception as exc:  # noqa: BLE001
                    print("coverage check failed", exc.__class__.__name__, exc)
                    verdict, cov = {}, "covered"
                if verdict:
                    verdict["framework"] = "the four core papers" if tier == "public" else "the Vichaar Repository"
                    rec["scope"] = verdict
                    label = {"covered": "The texts address this", "partial": "The texts only partly settle this", "not-covered": "The texts don't address this"}[cov]
                    yield trace("check", label, coverage=cov, missing=verdict.get("missing", ""), defined=verdict.get("defined", ""))
                    if cov != "covered":
                        yield ev(azaad_scope=verdict)
                        gap = verdict.get("missing") or "this"
                        scope_note = (f"\n\n## COVERAGE CHECK (binding)\nA check of the passages found that {verdict['framework']} "
                                      f"{'do not define' if cov == 'not-covered' else 'only partly define'} {gap}. "
                                      f"Open your answer with one plain sentence saying {gap} isn't fully defined in the Azadist framework. "
                                      "After that, anything you add beyond the passages must be labelled as your own reasoning from Azadist principles, "
                                      "not as the Institute's position. Do not write \"Azadism says\" or \"the Azadist position is\" about anything the passages don't state.")

                # 4. Answer, streaming the model's own reasoning first
                system = f"{self.persona}\n\n{self.council if council else ''}\n\n## LIBRARY EXCERPTS\n\n{excerpts}\n\n{SCOPE_RULE[tier]}{scope_note}"
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
                            state["first"] = time.time() - t0
                            yield trace("answer", "Answering")
                        if delta.get("content"):
                            state["answer"] += delta["content"]
                        chunk["model"] = cfg["model"]
                        yield chunk
                yield trace("done", "Done")

            def finish():
                if state["done"]:
                    return
                state["done"] = True
                rec["ms"] = int((time.time() - rec["ts"]) * 1000)
                rec["ms_first"] = int(state["first"] * 1000) if state["first"] else None
                ans = state["answer"]
                rec["answer_chars"] = len(ans)
                rec["answer_head"] = ans[:2000]
                rec["cited"] = sorted({int(n) for g in re.findall(r"\[(\d+(?:\s*[,;]\s*\d+)*)\]", ans) for n in re.split(r"[,;]", g) if n.strip().isdigit()})
                rec["cited_papers"] = list(dict.fromkeys(s["title"] for s in rec["src"] if s["n"] in rec["cited"]))
                rec["error"] = state["error"]
                rec["aborted"] = not ans and not state["error"]
                spawn(record(rec))

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
                    state["error"] = exc.__class__.__name__
                    finish()
                    return JSONResponse({"error": {"message": f"AzaadAI is unavailable: {exc}"}}, 502)
                finish()
                return {"object": "chat.completion", "model": cfg["model"],
                        "choices": [{"index": 0, "message": {"role": "assistant", "content": text, "reasoning_content": reasoning}, "finish_reason": "stop"}], **meta}

            async def stream():
                try:
                    async for e in run():
                        yield f"data: {json.dumps(e)}\n\n"
                except Exception as exc:  # noqa: BLE001
                    import traceback

                    traceback.print_exc()
                    state["error"] = exc.__class__.__name__
                    yield f"data: {json.dumps({'error': {'message': f'AzaadAI is unavailable right now ({exc.__class__.__name__}). Try again in a minute.'}})}\n\n"
                finally:
                    finish()  # also runs when the reader disconnects mid-answer
                yield "data: [DONE]\n\n"

            return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

        return api
