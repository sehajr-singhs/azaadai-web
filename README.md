# Azaad

The model of Bunga Azaadi (the Institute for Azadist Studies). Azaad is trained on the Institute's work, researches every question in the open, and cites each claim to its source.

**Site:** https://sehajr-singhs.github.io/azaadai-web/

## What it is

| Piece | Where | What it does |
| --- | --- | --- |
| **Azaad** (public) | Gemma 4 31B + LoRA `azaad` | Trained on the four core papers: the Azadist Manifesto, *Khalistan vs Khalsa Raaj*, *The Khalsa Is The Guru* (the Khalsa Status series) and *The Dharam Yudh Pipeline*. Searches only those. |
| **Azaad Research** (internal) | Gemma 4 31B + LoRA `azaad-research` | Trained on the whole Vichaar Repository. Needs an access code. Plans a wider search, checks its coverage for gaps, searches again, and writes at length. |
| GPU | RunPod Serverless (vLLM, FP8) | Scales to zero. The first answer after a quiet spell waits for a worker to boot. |
| Gateway | Modal (`server/azaad1.py`) | Holds the RunPod key and the access codes, indexes the library, runs the research loop, streams the trace. |
| Site | GitHub Pages (`src/`) | The console, with the line of research, sources and Council. |
| Terminal | `cli/azaad.py` | The same, in your shell. |

## How Azaad was trained

1. **Library.** Every page of bungaazaadi.com plus the Dharam Yudh Pipeline whitepaper (PDF, with kerning repaired) is fetched and split into about 1,200 passages (`server/azaad_lib.py`).
2. **Questions.** A teacher (Gemma 4 31B, thinking on) read each passage and wrote the questions real people ask: newcomers, skeptics, practitioners, serious students, comparisons, quizzes. That gave about 2,100 questions for the four papers and 1,700 for the rest of the repository (`train/gen_data.py questions`).
3. **Answers.** For each question the teacher saw a long window of the source document plus the retrieved passages the student will see, and wrote a short decision trace and a cited answer. Answers that cited passages that didn't exist, cited nothing, or talked about their own instructions were dropped (`train/gen_data.py answers`).
4. **Fine-tune.** LoRA (rank 32, all attention and MLP projections of the language model) on the student's view: persona and passages in, trace and answer out. The public adapter learned from the four papers only; the research adapter continued from it on the whole repository (`train/train_lora.py`).

The trace is trained into Gemma's thinking channel, so at serving time it streams as the model's reasoning: the line of research you see is the model's own, not a summary written afterwards.

The base model was picked by a bake-off: the same grounded questions through Qwen3.8-27B and Gemma 4 31B (`train/bakeoff.py`). Gemma engaged the source text more closely, reasoned in a tenth of the tokens, and made fewer factual slips.

## The line of research

For each question the gateway:

1. **Plans**: restates the question and writes several search queries from different angles.
2. **Searches** the library (BM25, fused across queries) and reports what each query found.
3. **Reflects** (research tier): names the gaps in what it found and searches again.
4. **Reads** the passages, then **reasons** (the model's thinking channel) and **answers** with `[n]` citations.

Each step streams as an `azaad_trace` event, the reasoning as `reasoning_content`, the passages as `azaad_sources`.

## The Swarm (beta)

`council: true` (the **Council** switch, or `azaad -c`) convenes eight voices before the answer: Bunga Strategist, Toshakhana Warden, Fauj Guardian, Parchaarak, Vyapari, Dandani, Gurmukh and Lok. Each holds a mandate and a known bias. Three passes (Attack, Counter, Refine), then only the synthesis is printed (`prompts/council.md`).

## API

OpenAI-compatible, with retrieval done for you:

```bash
curl -N $AZAAD_URL/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"azaad","stream":true,"messages":[{"role":"user","content":"What is Khalsa Raaj?"}]}'
```

| Field / header | Meaning |
| --- | --- |
| `council: true` | Arm the Council |
| `X-Azaad-Access: <code>` | Research tier (`mode: "public"` forces the public model) |
| `GET /v1/library/search?q=` | The passages Azaad would read |
| `GET /v1/status`, `POST /v1/warm` | Whether a GPU worker is up; start one |

Limits: 40 messages per 10 minutes per IP on the public tier, 300 per code on research.

## Terminal

```powershell
irm https://sehajr-singhs.github.io/azaadai-web/install.ps1 | iex     # Windows
```
```bash
curl -fsSL https://sehajr-singhs.github.io/azaadai-web/install.sh | sh  # macOS / Linux
```

`azaad`, `azaad "question"`, `azaad -c "question"`, `azaad login <code>`, `azaad status`. Engines: `azaad` (default), `ollama` and `claude` (Claude Code), the last two fed the same library passages.

## Run it yourself

```bash
npm install && npm run dev                                  # site, http://localhost:5173/azaadai-web/
modal deploy server/azaad1.py                               # gateway
```

Modal secrets: `azaad-runpod` (`RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID`) and `azaad-access` (`AZAAD_ACCESS_CODES="group:code,..."`). Set the gateway URL as the repo variable `AZAAD_URL`; every push to `main` rebuilds the site.

All library text belongs to Bunga Azaadi.
