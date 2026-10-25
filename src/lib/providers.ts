// Every model call goes straight from the visitor's browser to the provider.
// Keys never touch an AzaadAI server.

export type ProviderId =
  | "azaad-cloud"
  | "azaad-local"
  | "anthropic"
  | "openai"
  | "openrouter"
  | "gemini"
  | "groq"
  | "ollama"
  | "custom";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  blurb: string;
  needsKey: boolean;
  keyUrl?: string;
  baseUrl?: string;
  models: string[];
  // How much library text to attach. Small local models get less.
  budget: number;
  hits: number;
}

// Set at build time once the Modal endpoint is deployed (see server/README.md).
export const AZAAD_CLOUD_URL: string = import.meta.env.VITE_AZAAD_CLOUD_URL ?? "";

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "azaad-cloud",
    label: "Azaad-1 · Cloud",
    blurb: "Our model on a cloud GPU with the library built in. Free, no key.",
    needsKey: false,
    baseUrl: AZAAD_CLOUD_URL,
    models: ["azaad-1"],
    budget: 14000,
    hits: 10,
  },
  {
    id: "azaad-local",
    label: "Azaad-1 · On-device",
    blurb: "Runs fully in your browser on WebGPU. Private, offline after first load.",
    needsKey: false,
    models: ["Qwen3.5-4B-q4f16_1-MLC", "Qwen3.5-2B-q4f16_1-MLC", "Qwen3.5-9B-q4f16_1-MLC"],
    budget: 5500,
    hits: 5,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    blurb: "Claude, with your own API key.",
    needsKey: true,
    keyUrl: "https://console.anthropic.com/settings/keys",
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
    budget: 24000,
    hits: 12,
  },
  {
    id: "openai",
    label: "OpenAI",
    blurb: "GPT models, with your own API key.",
    needsKey: true,
    keyUrl: "https://platform.openai.com/api-keys",
    baseUrl: "https://api.openai.com/v1",
    models: [],
    budget: 24000,
    hits: 12,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    blurb: "Hundreds of models through one key, including free ones.",
    needsKey: true,
    keyUrl: "https://openrouter.ai/keys",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [],
    budget: 20000,
    hits: 10,
  },
  {
    id: "gemini",
    label: "Google Gemini",
    blurb: "Gemini, with a Google AI Studio key.",
    needsKey: true,
    keyUrl: "https://aistudio.google.com/apikey",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: [],
    budget: 24000,
    hits: 12,
  },
  {
    id: "groq",
    label: "Groq",
    blurb: "Very fast open models, with a Groq key.",
    needsKey: true,
    keyUrl: "https://console.groq.com/keys",
    baseUrl: "https://api.groq.com/openai/v1",
    models: [],
    budget: 14000,
    hits: 8,
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    blurb: "Any model on your own machine. Start Ollama with OLLAMA_ORIGINS set to this site.",
    needsKey: false,
    baseUrl: "http://localhost:11434/v1",
    models: [],
    budget: 10000,
    hits: 6,
  },
  {
    id: "custom",
    label: "Custom endpoint",
    blurb: "Any OpenAI-compatible API (vLLM, LM Studio, Together, your own server).",
    needsKey: false,
    models: [],
    budget: 16000,
    hits: 8,
  },
];

export const provider = (id: ProviderId) => PROVIDERS.find((p) => p.id === id)!;

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

export interface StreamArgs {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  system: string;
  messages: ChatMsg[];
  signal: AbortSignal;
  onToken: (t: string) => void;
  onStatus?: (s: string) => void;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

async function* sse(resp: Response): AsyncGenerator<string> {
  const reader = resp.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

async function fail(resp: Response, who: string): Promise<never> {
  let msg = `${resp.status} ${resp.statusText}`;
  try {
    const j = await resp.json();
    msg = j.error?.message ?? j.message ?? j.detail ?? JSON.stringify(j);
  } catch {
    /* not JSON */
  }
  if (resp.status === 401 || resp.status === 403) msg = `${who} rejected the API key. ${msg}`;
  throw new Error(msg);
}

async function streamAnthropic(a: StreamArgs) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: a.signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": a.apiKey ?? "",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: a.model, max_tokens: 4096, system: a.system, messages: a.messages, stream: true }),
  });
  if (!resp.ok) await fail(resp, "Anthropic");
  for await (const data of sse(resp)) {
    const ev = JSON.parse(data);
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") a.onToken(ev.delta.text);
    if (ev.type === "error") throw new Error(ev.error?.message ?? "Anthropic stream error");
  }
}

async function streamOpenAI(a: StreamArgs, base: string, extra: Record<string, unknown> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (a.apiKey) headers.authorization = `Bearer ${a.apiKey}`;
  if (a.provider === "openrouter") {
    headers["HTTP-Referer"] = location.origin;
    headers["X-Title"] = "AzaadAI";
  }
  const resp = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal: a.signal,
    headers,
    body: JSON.stringify({
      model: a.model,
      stream: true,
      messages: [{ role: "system", content: a.system }, ...a.messages],
      ...extra,
    }),
  });
  if (!resp.ok) await fail(resp, provider(a.provider).label);
  for await (const data of sse(resp)) {
    if (data === "[DONE]") break;
    const ev = JSON.parse(data);
    if (ev.error) throw new Error(ev.error.message ?? String(ev.error));
    const t = ev.choices?.[0]?.delta?.content;
    if (t) a.onToken(t);
  }
}

export async function streamChat(a: StreamArgs): Promise<void> {
  const info = provider(a.provider);
  switch (a.provider) {
    case "anthropic":
      return streamAnthropic(a);
    case "azaad-local":
      return streamLocal(a);
    case "azaad-cloud":
      if (!info.baseUrl) throw new Error("Azaad-1 Cloud isn't configured on this build yet.");
      a.onStatus?.("Waking the GPU (first message after idle can take ~1 min)…");
      return streamOpenAI(a, `${info.baseUrl}/v1`);
    case "custom":
    case "ollama":
      return streamOpenAI(a, a.baseUrl || info.baseUrl || "");
    default:
      return streamOpenAI(a, info.baseUrl!);
  }
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

export async function listModels(id: ProviderId, apiKey?: string, baseUrl?: string): Promise<string[]> {
  const info = provider(id);
  if (id === "azaad-local" || id === "azaad-cloud") return info.models;
  if (id === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    });
    if (!r.ok) await fail(r, "Anthropic");
    return (await r.json()).data.map((m: { id: string }) => m.id);
  }
  const base = (baseUrl || info.baseUrl || "").replace(/\/$/, "");
  const r = await fetch(`${base}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
  if (!r.ok) await fail(r, info.label);
  const ids: string[] = (await r.json()).data.map((m: { id: string }) => m.id.replace(/^models\//, ""));
  if (id === "openai") return ids.filter((m) => /^(gpt|o\d|chatgpt)/.test(m) && !/audio|realtime|image|tts|transcribe|search/.test(m)).sort().reverse();
  if (id === "openrouter") return ids.sort((a, b) => Number(b.endsWith(":free")) - Number(a.endsWith(":free")));
  if (id === "gemini") return ids.filter((m) => m.startsWith("gemini") && !/embedding|image|tts|live/.test(m)).sort().reverse();
  return ids;
}

// ---------------------------------------------------------------------------
// On-device Azaad-1 (WebLLM in a worker)
// ---------------------------------------------------------------------------

type Engine = import("@mlc-ai/web-llm").WebWorkerMLCEngine;
let engine: Engine | null = null;
let engineModel = "";

export const hasWebGPU = () => typeof navigator !== "undefined" && "gpu" in navigator;

export async function loadLocal(model: string, onStatus: (s: string) => void): Promise<Engine> {
  if (engine && engineModel === model) return engine;
  if (!hasWebGPU()) throw new Error("This browser has no WebGPU. Use Chrome or Edge on desktop, or pick Azaad-1 Cloud.");
  const webllm = await import("@mlc-ai/web-llm");
  if (engine) await engine.unload();
  engine = await webllm.CreateWebWorkerMLCEngine(
    new Worker(new URL("./webllm.worker.ts", import.meta.url), { type: "module" }),
    model,
    {
      initProgressCallback: (p) => onStatus(p.text.replace(/\[.*?\]\s*/, "")),
    },
    { context_window_size: 8192 },
  );
  engineModel = model;
  return engine;
}

async function streamLocal(a: StreamArgs) {
  const e = await loadLocal(a.model, (s) => a.onStatus?.(s));
  a.onStatus?.("");
  const chunks = await e.chat.completions.create({
    stream: true,
    messages: [{ role: "system", content: a.system }, ...a.messages],
    temperature: 0.7,
    top_p: 0.8,
    max_tokens: 1500,
    extra_body: { enable_thinking: false },
  });
  for await (const c of chunks) {
    if (a.signal.aborted) {
      e.interruptGenerate();
      break;
    }
    const t = c.choices[0]?.delta?.content;
    if (t) a.onToken(t);
  }
}
