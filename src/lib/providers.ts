// Bring your own model. The browser calls the provider directly with the
// visitor's key; the Azaad gateway only supplies the library passages.

import { errorText, sse, type ChatMsg } from "./api";

export type ProviderId = "anthropic" | "openai" | "openrouter" | "gemini" | "groq" | "ollama" | "custom";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  needsKey: boolean;
  keyUrl?: string;
  baseUrl?: string;
  placeholder: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { id: "anthropic", label: "Anthropic", needsKey: true, keyUrl: "https://console.anthropic.com/settings/keys", baseUrl: "https://api.anthropic.com/v1", placeholder: "claude-sonnet-5-5" },
  { id: "openai", label: "OpenAI", needsKey: true, keyUrl: "https://platform.openai.com/api-keys", baseUrl: "https://api.openai.com/v1", placeholder: "gpt-5" },
  { id: "openrouter", label: "OpenRouter", needsKey: true, keyUrl: "https://openrouter.ai/keys", baseUrl: "https://openrouter.ai/api/v1", placeholder: "google/gemma-4-31b-it" },
  { id: "gemini", label: "Google Gemini", needsKey: true, keyUrl: "https://aistudio.google.com/apikey", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", placeholder: "gemini-2.5-pro" },
  { id: "groq", label: "Groq", needsKey: true, keyUrl: "https://console.groq.com/keys", baseUrl: "https://api.groq.com/openai/v1", placeholder: "openai/gpt-oss-120b" },
  { id: "ollama", label: "Ollama", needsKey: false, baseUrl: "http://localhost:11434/v1", placeholder: "gemma4:31b" },
  { id: "custom", label: "Custom (OpenAI-compatible)", needsKey: false, placeholder: "model id" },
];

export const provider = (id: ProviderId) => PROVIDERS.find((p) => p.id === id)!;

export interface ByokArgs {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  system: string;
  messages: ChatMsg[];
  signal: AbortSignal;
  onToken: (t: string) => void;
}

async function fail(resp: Response, who: string): Promise<never> {
  const msg = await errorText(resp);
  throw new Error(resp.status === 401 || resp.status === 403 ? `${who} rejected the key. ${msg}` : msg);
}

async function streamAnthropic(a: ByokArgs) {
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

async function streamOpenAI(a: ByokArgs, base: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (a.apiKey) headers.authorization = `Bearer ${a.apiKey}`;
  if (a.provider === "openrouter") {
    headers["HTTP-Referer"] = location.origin;
    headers["X-Title"] = "Azaad";
  }
  const resp = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal: a.signal,
    headers,
    body: JSON.stringify({ model: a.model, stream: true, messages: [{ role: "system", content: a.system }, ...a.messages] }),
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

export function streamByok(a: ByokArgs): Promise<void> {
  if (a.provider === "anthropic") return streamAnthropic(a);
  const base = a.baseUrl || provider(a.provider).baseUrl;
  if (!base) throw new Error("Set the endpoint URL in Settings.");
  return streamOpenAI(a, base);
}
