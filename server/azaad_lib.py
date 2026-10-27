"""The Bunga Azaadi library: fetch, clean, chunk and BM25-search.

Shared by the gateway (server/azaad1.py) and the training pipeline
(train/). No Modal or GPU dependencies.

Two tiers:
  public    the four core papers: the Azadist Manifesto, Khalistan vs Khalsa
            Raaj, The Khalsa Is The Guru (the Khalsa Status series) and the
            Dharam Yudh Pipeline
  research  the whole Vichaar Repository
"""

import json
import math
import re
import time
import urllib.parse
from collections import Counter, defaultdict
from pathlib import Path

SITE_UID = "8a12b61764a2b0b075c408ab3423a91e"
HOST = "https://publish-01.obsidian.md"
DYP_PDF = "img/Dharam_Yudh_Pipeline_Whitepaper.pdf"
DYP_PATH = "Khalsa Revival/Dharam Yudh Pipeline/Dharam Yudh Pipeline Whitepaper.md"

PUBLIC = [r"Azadist Manifesto/", r"Khalistan Vs Khalsa Raaj", r"Khalsa Status/", r"Dharam Yudh Pipeline"]
PAPERS = [
    ("The Azadist Manifesto", r"Azadist Manifesto/"),
    ("Khalistan vs Khalsa Raaj", r"Khalistan Vs Khalsa Raaj"),
    ("The Khalsa Is The Guru", r"Khalsa Status/"),
    ("The Dharam Yudh Pipeline", r"Dharam Yudh Pipeline"),
]
STOP = set(
    "a an and are as at be but by for from has have he her his i if in into is it its of on or our she so than that the their them then "
    "there these they this to was we were what when which who why will with you your not do does did can could should would about how "
    "all any more most also just only over such".split()
)


def is_public(path: str) -> bool:
    return any(re.search(p, path) for p in PUBLIC)


def paper_of(path: str) -> str | None:
    return next((name for name, p in PAPERS if re.search(p, path)), None)


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
    """Rejoin words that a kerned PDF split apart, using corpus word frequencies."""

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


def fetch_docs() -> list[dict]:
    """Every document on bungaazaadi.com, plus the DYP whitepaper PDF, cleaned."""
    from concurrent.futures import ThreadPoolExecutor

    import httpx
    from pypdf import PdfReader

    docs = []
    with httpx.Client(timeout=60, follow_redirects=True) as http:
        index = http.get(f"{HOST}/cache/{SITE_UID}").json()
        vocab: Counter = Counter({"dyp": 50})
        paths = [p for p in index if p.endswith(".md")]

        def get(path):
            try:
                r = http.get(f"{HOST}/access/{SITE_UID}/{urllib.parse.quote(path)}")
                r.raise_for_status()
                return path, r.text
            except Exception as exc:  # noqa: BLE001
                print("skip", path, exc)
                return path, None

        with ThreadPoolExecutor(16) as pool:
            fetched = list(pool.map(get, paths))
        for path, raw in fetched:
            if raw is None:
                continue
            text = clean_markdown(raw)
            if len(text) < 120:
                continue
            vocab.update(re.findall(r"[a-z']{2,}", text.lower()))
            title = re.sub(r"^\d+\s+", "", path.split("/")[-1].removesuffix(".md"))
            docs.append({"path": path, "title": title, "url": public_url(path), "text": text})
        try:
            import tempfile

            pdf = http.get(f"{HOST}/access/{SITE_UID}/{urllib.parse.quote(DYP_PDF)}").content
            tmp = Path(tempfile.gettempdir()) / "dyp.pdf"
            tmp.write_bytes(pdf)
            raw = "\n".join(p.extract_text() or "" for p in PdfReader(tmp).pages)
            raw = "\n".join(l for l in raw.split("\n") if "Whitepaper Published by Bunga Azaadi" not in l)
            docs.append({
                "path": DYP_PATH,
                "title": "The Dharam Yudh Pipeline (Whitepaper)",
                "url": public_url("Khalsa Revival/Dharam Yudh Pipeline/Dharam Yudh Pipeline.md"),
                "text": despace(re.sub(r"[ \t]+", " ", raw), vocab),
            })
        except Exception as exc:  # noqa: BLE001
            print("DYP whitepaper unavailable", exc)
    return docs


def load_docs(cache: Path | None = None, max_age: float = 24 * 3600) -> tuple[list[dict], bool]:
    """(docs, fetched_fresh). Reuses a cached copy of the raw texts when fresh."""
    if cache and cache.exists() and time.time() - cache.stat().st_mtime < max_age:
        return json.loads(cache.read_text(encoding="utf-8")), False
    docs = fetch_docs()
    if cache:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(docs), encoding="utf-8")
    return docs, True


class Library:
    def __init__(self, docs: list[dict], public_only: bool = False):
        self.docs: list[dict] = []
        self.chunks: list[tuple[int, str, str]] = []
        self.tf: list[Counter] = []
        self.df: Counter = Counter()
        for d in docs:
            if public_only and not is_public(d["path"]):
                continue
            self._add(d)
        self.avg = sum(sum(c.values()) for c in self.tf) / max(1, len(self.tf))

    def _add(self, doc: dict):
        d = len(self.docs)
        self.docs.append({**{k: doc[k] for k in ("path", "title", "url")}, "core": is_public(doc["path"]), "paper": paper_of(doc["path"])})
        for heading, body in chunk_doc(doc["text"], doc["title"]):
            c = Counter(tokenize(body) + tokenize(f"{doc['title']} {heading}") * 2)
            self.df.update(c.keys())
            self.tf.append(c)
            self.chunks.append((d, heading, body))

    def search(self, query: str, k: int = 10, max_per_doc: int = 3, exclude: set[int] | None = None) -> list[tuple[int, float]]:
        q = set(tokenize(query))
        n = len(self.tf)
        scored = []
        for i, tf in enumerate(self.tf):
            if exclude and i in exclude:
                continue
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

    def source(self, i: int, n: int) -> dict:
        d, heading, _ = self.chunks[i]
        doc = self.docs[d]
        return {"n": n, "title": doc["title"], "heading": heading if heading != doc["title"] else "", "url": doc["url"], "core": doc["core"], "paper": doc["paper"]}

    def excerpts(self, ids: list[int], budget: int = 14000) -> tuple[str, list[dict]]:
        out, sources = "", []
        for n, i in enumerate(ids, 1):
            d, heading, body = self.chunks[i]
            doc = self.docs[d]
            block = f"[{n}] {doc['title']}{f' > {heading}' if heading != doc['title'] else ''}\n{body}\n\n"
            if len(out) + len(block) > budget and n > 1:
                break
            out += block
            sources.append(self.source(i, n))
        return out.strip(), sources
