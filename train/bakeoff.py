"""Same grounded prompts through each candidate; dump answers for side-by-side review.

    python train/bakeoff.py --out bakeoff.json qwen=http://localhost:8001/v1 gemma=http://localhost:8002/v1
"""

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))
import azaad_lib as L  # noqa: E402

QUESTIONS = [
    "I'm new to this. What is Khalsa Raaj, and how is it different from Khalistan?",
    "Explain the three stages of the Dharam Yudh Pipeline and why it insists on working inside existing forces first.",
    "If the Khalsa is the Guru, who actually makes decisions for the Panth today, and why isn't it the Akal Takht Jathedar?",
    "Steelman the objection that taxes fund the poor, then answer it the way the Azadist Manifesto does.",
    "My cousin says the Panth should only push for a Khalistan referendum. How would you change his mind in five minutes?",
    "I'm 19 and want to serve the Panth. Using the DYP, what should my next five years look like?",
    "Isn't a Khalsa-led private military company just a mercenary outfit with a turban on? Be honest.",
    "What would an Azadist say about how a modern Misl should handle a dispute between two Sikh businesses?",
]


def ask(base: str, model: str, system: str, q: str, think: bool) -> dict:
    t0 = time.time()
    r = httpx.post(f"{base}/chat/completions", timeout=600, json={
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": q}],
        "max_tokens": 6000,
        "temperature": 0.7,
        "chat_template_kwargs": {"enable_thinking": think},
    })
    r.raise_for_status()
    m = r.json()["choices"][0]["message"]
    usage = r.json().get("usage", {})
    return {"answer": m.get("content") or "", "reasoning": m.get("reasoning_content") or m.get("reasoning") or "",
            "secs": round(time.time() - t0, 1), "tokens": usage.get("completion_tokens")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--docs", default="docs.json")
    ap.add_argument("--out", default="bakeoff.json")
    ap.add_argument("--think", action="store_true")
    ap.add_argument("targets", nargs="+")
    a = ap.parse_args()

    lib = L.Library(json.loads(Path(a.docs).read_text(encoding="utf-8")), public_only=True)
    persona = (ROOT / "prompts" / "azaad.md").read_text(encoding="utf-8")
    systems = []
    for q in QUESTIONS:
        text, _ = lib.excerpts([i for i, _ in lib.search(q, 10)], 14000)
        systems.append(f"{persona}\n\n## LIBRARY EXCERPTS\n\n{text}")

    out = {}
    for t in a.targets:
        name, base = t.split("=", 1)
        with ThreadPoolExecutor(8) as pool:
            out[name] = list(pool.map(lambda qs: ask(base, name, qs[1], qs[0], a.think), zip(QUESTIONS, systems)))
        print(name, "done", [r["secs"] for r in out[name]])
    Path(a.out).write_text(json.dumps({"questions": QUESTIONS, "results": out}, indent=1, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
