# AzaadAI

AI counsel grounded in the Azadist Manifesto and the Bunga Azaadi Vichaar Repository, with every claim cited back to the source.

**Live:** https://sehajr-singhs.github.io/azaadai-web/

## Three ways to run it

| Mode | Where it runs | Key | Notes |
| --- | --- | --- | --- |
| **Azaad-1 Cloud** | Gateway on Modal (persona + library, retrieval server-side) in front of NVIDIA Nemotron 3 Ultra 550B, failing over to Nemotron 3 Super 120B, optional keyed providers, and optionally our own Qwen3.5-9B on an L4 GPU (vLLM, FP8, MTP) | none | Each answer reports which upstream served it. A cold start takes about 30s. |
| **Azaad-1 On-device** | Qwen3.5 2B/4B/9B in the browser via WebLLM + WebGPU | none | Fully private. One-time model download, then offline. |
| **Bring your own key** | Anthropic, OpenAI, Gemini, Groq, OpenRouter, Ollama, any OpenAI-compatible server | yours | The browser calls the provider directly. The key is stored only in your browser. |

## How grounding works

1. On first visit the site loads the whole Vichaar Repository live from bungaazaadi.com's public Obsidian Publish source, including the Dharam Yudh Pipeline whitepaper (PDF, extracted with pdf.js). It's cached in IndexedDB for 24 hours. No library text is stored in this repo.
2. Each question runs BM25 retrieval over about 1,200 passages, with a boost for the core papers (the Manifesto, *Khalistan vs Khalsa Raaj*, *The Khalsa Is The Guru*, the Dharam Yudh Pipeline, *Azadism in 500 Words*).
3. The top passages go to the model as numbered excerpts, alongside the Azaad persona (`prompts/azaad.md`). Optional **Council** mode adds the eight-voice debate (`prompts/council.md`).
4. The model cites `[n]` inline. The UI turns each citation into a link to the original page.

## Azaad-1 API

OpenAI-compatible. Retrieval happens server-side, so a plain request is already grounded:

```bash
curl -N $AZAAD_CLOUD_URL/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"azaad-1","stream":true,"messages":[{"role":"user","content":"What is Khalsa Raaj?"}]}'
```

The stream's first chunk carries `azaad_upstream` (which backend answered) and `azaad_sources` (the passages used). Add `"council": true` for council mode. Also available: `GET /health`, `GET /v1/models` and `GET /v1/library/search?q=...`. The limit is 30 messages per 10 minutes per IP.

Upstream order lives in `upstreams()` in `server/azaad1.py`. To add keyed fallbacks, put `NVIDIA_API_KEY`, `GROQ_API_KEY` or `OPENROUTER_API_KEY` in the `azaad-upstreams` Modal secret. To put our own GPU model first, run `AZAAD_GPU=1 modal deploy server/azaad1.py` (needs a payment method on the Modal workspace).

## Develop

```bash
npm install
npm run dev                                   # http://localhost:5173/azaadai-web/
VITE_AZAAD_CLOUD_URL=https://... npm run build
```

Deploy the gateway with `modal deploy server/azaad1.py`, then set the printed URL as the repo variable `AZAAD_CLOUD_URL` (Settings → Variables). Every push to `main` rebuilds the Pages site.

## Credit

Independent open-source project built on the public work of [Bunga Azaadi](https://bungaazaadi.com) (Institute for Azadist Studies). It is not an official Bunga Azaadi product. All library text belongs to its authors.
