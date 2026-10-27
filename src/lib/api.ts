// Client for the Azaad gateway. The gateway holds the RunPod key, the library
// index and the access codes; the browser only ever talks to it.

export const GATEWAY: string = (import.meta.env.VITE_AZAAD_URL ?? "").replace(/\/$/, "");

export interface Source {
  n: number;
  title: string;
  heading: string;
  url: string;
  core: boolean;
  paper: string | null;
}

export interface TraceStep {
  step: "plan" | "search" | "reflect" | "read" | "reason" | "answer" | "done" | string;
  title: string;
  ms: number;
  intent?: string;
  queries?: string[];
  searches?: { query: string; found: string[] }[];
  gaps?: string[];
  documents?: string[];
  detail?: string;
}

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

export interface StreamHandlers {
  onMeta?: (m: { tier: string; model: string; council: boolean }) => void;
  onTrace?: (t: TraceStep) => void;
  onSources?: (s: Source[]) => void;
  onReasoning?: (t: string) => void;
  onToken?: (t: string) => void;
}

function headers(code?: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (code) h["x-azaad-access"] = code;
  return h;
}

export async function* sse(resp: Response): AsyncGenerator<string> {
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

export async function errorText(resp: Response): Promise<string> {
  try {
    const j = await resp.json();
    return j.error?.message ?? j.detail ?? `${resp.status} ${resp.statusText}`;
  } catch {
    return `${resp.status} ${resp.statusText}`;
  }
}

export async function status(): Promise<{ warm: boolean; starting: boolean }> {
  const r = await fetch(`${GATEWAY}/v1/status`);
  return r.json();
}

export function warm() {
  if (GATEWAY) fetch(`${GATEWAY}/v1/warm`, { method: "POST" }).catch(() => {});
}

export async function unlock(code: string): Promise<{ group: string }> {
  const r = await fetch(`${GATEWAY}/v1/access`, { method: "POST", headers: headers(), body: JSON.stringify({ code }) });
  if (!r.ok) throw new Error(await errorText(r));
  return r.json();
}

export async function search(q: string, code?: string, k = 10): Promise<{ tier: string; sources: Source[]; excerpts: string }> {
  const r = await fetch(`${GATEWAY}/v1/library/search?q=${encodeURIComponent(q)}&k=${k}`, { headers: headers(code) });
  if (!r.ok) throw new Error(await errorText(r));
  return r.json();
}

export async function streamAzaad(
  args: { messages: ChatMsg[]; council: boolean; mode: "public" | "research"; code?: string; signal: AbortSignal },
  h: StreamHandlers,
) {
  if (!GATEWAY) throw new Error("This build isn't connected to the Azaad gateway.");
  const resp = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: "POST",
    signal: args.signal,
    headers: headers(args.code),
    body: JSON.stringify({ model: "azaad", stream: true, messages: args.messages, council: args.council, mode: args.mode }),
  });
  if (!resp.ok) throw new Error(await errorText(resp));
  for await (const data of sse(resp)) {
    if (data === "[DONE]") break;
    const ev = JSON.parse(data);
    if (ev.error) throw new Error(ev.error.message ?? String(ev.error));
    if (ev.azaad_meta) h.onMeta?.(ev.azaad_meta);
    if (ev.azaad_trace) h.onTrace?.(ev.azaad_trace);
    if (ev.azaad_sources) h.onSources?.(ev.azaad_sources);
    const d = ev.choices?.[0]?.delta;
    if (d?.reasoning_content || d?.reasoning) h.onReasoning?.(d.reasoning_content ?? d.reasoning);
    if (d?.content) h.onToken?.(d.content);
  }
}
