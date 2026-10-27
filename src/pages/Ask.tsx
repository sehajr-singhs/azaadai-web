import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import persona from "../../prompts/azaad.md?raw";
import council from "../../prompts/council.md?raw";
import { Arrow, Dome, Header } from "../components/brand";
import { Internal } from "../components/Internal";
import { search, status, streamAzaad, warm, type ChatMsg, type Source, type TraceStep } from "../lib/api";
import { PROVIDERS, provider, streamByok, type ProviderId } from "../lib/providers";
import { loadConversations, loadKey, saveConversations, saveKey, uid, type Conversation, type Settings, type Turn } from "../lib/store";

const SUGGESTIONS = [
  "What is Khalsa Raaj, and how is it different from Khalistan?",
  "Walk me through the three stages of the Dharam Yudh Pipeline.",
  "If the Khalsa is the Guru, who decides for the Panth today?",
  "Steelman the case for taxes, then answer it the way the Manifesto does.",
];

// ---------------------------------------------------------------------------
// Answer rendering
// ---------------------------------------------------------------------------

function linkCitations(md: string): string {
  return md.replace(/\[(\d+(?:\s*[,;]\s*\d+)*)\](?!\()/g, (_, nums: string) =>
    nums
      .split(/[,;]/)
      .map((n) => `[${n.trim()}](#cite-${n.trim()})`)
      .join(""),
  );
}

function Answer({ text, sources, live }: { text: string; sources: Source[]; live: boolean }) {
  const byN = useMemo(() => new Map(sources.map((s) => [s.n, s])), [sources]);
  return (
    <div className={`answer ${live ? "caret" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const m = href?.match(/^#cite-(\d+)$/);
            if (m) {
              const s = byN.get(Number(m[1]));
              return (
                <a className="cite" href={s?.url} target="_blank" rel="noreferrer" title={s ? `${s.title}${s.heading ? ` › ${s.heading}` : ""}` : undefined}>
                  {m[1]}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {linkCitations(text)}
      </ReactMarkdown>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Line of research
// ---------------------------------------------------------------------------

function ReasoningText({ text, live }: { text: string; live: boolean }) {
  const lines = text.split("\n").filter((l) => l.trim());
  return (
    <div className={`flex flex-col gap-1.5 text-[12.5px] leading-[1.5] text-paper/70 ${live ? "caret" : ""}`}>
      {lines.map((l, i) => {
        const m = l.replace(/^\s*[-*]\s*/, "").match(/^([A-Z][A-Za-z ]{2,18}):\s*(.*)$/);
        return m ? (
          <p key={i}>
            <span className="font-semibold text-paper/90">{m[1]}.</span> {m[2]}
          </p>
        ) : (
          <p key={i}>{l.replace(/^\s*[-*]\s*/, "")}</p>
        );
      })}
    </div>
  );
}

function Trace({ turn }: { turn: Turn }) {
  const running = turn.status === "running";
  const steps = turn.trace.filter((s) => s.step !== "answer" && s.step !== "done" && !(s.step === "plan" && s.title === "Reading the question" && turn.trace.some((x) => x.title === "Understood the question")));
  const last = steps[steps.length - 1];
  const answering = turn.answer.length > 0;
  return (
    <ol className="flex flex-col gap-4">
      {steps.map((s, i) => {
        const active = running && s === last && !answering;
        return (
          <li key={i} className="relative pl-4">
            <span className={`absolute left-0 top-[6px] h-[6px] w-[6px] rounded-full ${active ? "animate-pulse bg-blue" : "bg-paper/60"}`} />
            <p className="flex items-baseline justify-between gap-2 text-[12.5px] font-semibold">
              <span>{s.title}</span>
              <span className="font-mono text-[10.5px] font-normal text-ash-5">{(s.ms / 1000).toFixed(1)}s</span>
            </p>
            <StepDetail s={s} turn={turn} live={running && s.step === "reason" && !answering} />
          </li>
        );
      })}
      {running && !steps.length && <li className="pl-4 text-[12.5px] text-paper/60">Starting…</li>}
    </ol>
  );
}

function StepDetail({ s, turn, live }: { s: TraceStep; turn: Turn; live: boolean }) {
  const chip = (q: string, k: number) => (
    <span key={k} className="mr-1 mt-1 inline-block rounded-[3px] bg-paper/[0.07] px-1.5 py-0.5 font-mono text-[10.5px] text-paper/75">
      {q}
    </span>
  );
  const searches = (list?: { query: string; found: string[] }[]) =>
    list?.map((x, k) => (
      <div key={k} className="mt-1.5">
        {chip(x.query, 0)}
        {x.found.length > 0 && <p className="mt-0.5 text-[11.5px] text-paper/50">→ {x.found.slice(0, 3).join(" · ")}</p>}
      </div>
    ));
  switch (s.step) {
    case "wake":
      return s.detail ? <p className="mt-1 text-[12px] leading-[1.45] text-paper/55">{s.detail}</p> : null;
    case "plan":
      return s.intent ? <p className="mt-1 text-[12.5px] italic leading-[1.45] text-paper/70">{s.intent}</p> : null;
    case "search":
      return <div className="mt-0.5">{searches(s.searches)}</div>;
    case "reflect":
      return (
        <div className="mt-1">
          {s.gaps?.map((g, k) => (
            <p key={k} className="text-[12px] leading-[1.45] text-paper/65">
              Gap: {g}
            </p>
          ))}
          {searches(s.searches)}
        </div>
      );
    case "read":
      return (
        <ul className="mt-1 flex flex-col gap-0.5 text-[11.5px] text-paper/55">
          {s.documents?.slice(0, 8).map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      );
    case "reason":
      return turn.reasoning ? (
        <div className="mt-1.5">
          <ReasoningText text={turn.reasoning} live={live} />
        </div>
      ) : null;
    default:
      return null;
  }
}

function Sources({ sources, cited }: { sources: Source[]; cited: Set<number> }) {
  const [all, setAll] = useState(false);
  const list = all ? sources : sources.filter((s) => cited.has(s.n));
  if (!sources.length) return null;
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[12px] font-semibold text-paper/60">
        Sources · {cited.size} cited of {sources.length} read
      </p>
      <ol className="flex flex-col gap-2.5">
        {(list.length ? list : sources).map((s) => (
          <li key={s.n} className="flex gap-2 text-[12.5px] leading-[1.4]">
            <span className="cite mt-[3px] shrink-0 translate-y-0">{s.n}</span>
            <a href={s.url} target="_blank" rel="noreferrer" className="group min-w-0">
              <span className="text-paper/90 group-hover:underline">{s.title}</span>
              {s.heading && <span className="block text-paper/50">{s.heading}</span>}
            </a>
          </li>
        ))}
      </ol>
      {sources.length > cited.size && cited.size > 0 && (
        <button type="button" onClick={() => setAll(!all)} className="w-fit text-[12px] text-paper/50 hover:text-paper">
          {all ? "Show cited only" : "Show everything read"}
        </button>
      )}
    </div>
  );
}

function Exchange({ turn, onRetry }: { turn: Turn; onRetry: () => void }) {
  const [open, setOpen] = useState(false);
  const cited = useMemo(() => new Set([...turn.answer.matchAll(/\[(\d+(?:\s*[,;]\s*\d+)*)\]/g)].flatMap((m) => m[1].split(/[,;]/).map((n) => Number(n.trim())))), [turn.answer]);
  const running = turn.status === "running";
  const tierLabel = turn.tier === "research" ? "Research" : turn.tier === "byok" ? turn.model : "Public";
  return (
    <article className="grid grid-cols-1 gap-6 border-t border-ash-3 py-10 lg:grid-cols-[230px_minmax(0,1fr)_230px] lg:gap-10 xl:grid-cols-[260px_minmax(0,680px)_260px] xl:justify-center">
      <aside className="order-2 lg:order-1">
        <button type="button" onClick={() => setOpen(!open)} className="mb-3 flex w-full items-center justify-between text-left lg:pointer-events-none">
          <span className="label">Line of research</span>
          <span className="text-[12px] text-paper/50 lg:hidden">{open ? "Hide" : "Show"}</span>
        </button>
        <div className={`${open ? "block" : "hidden"} lg:sticky lg:top-20 lg:block lg:max-h-[calc(100vh-190px)] lg:overflow-y-auto lg:pr-2`}>
          <Trace turn={turn} />
        </div>
      </aside>
      <div className="order-1 min-w-0 lg:order-2">
        <p className="mb-2 flex flex-wrap items-center gap-2 text-[11.5px] font-medium text-paper/50">
          <span>{tierLabel}</span>
          {turn.council && <span>· Council</span>}
          {turn.ms && <span>· {(turn.ms / 1000).toFixed(1)}s</span>}
        </p>
        <h2 className="mb-6 text-[24px] font-semibold leading-[1.2] tracking-[-0.02em] md:text-[28px]">{turn.q}</h2>
        {turn.answer ? (
          <Answer text={turn.answer} sources={turn.sources} live={running} />
        ) : running ? (
          <p className="text-[15px] text-paper/50">{turn.trace.length ? "Researching…" : "Connecting…"}</p>
        ) : null}
        {turn.status === "error" && (
          <div className="mt-4 flex flex-wrap items-center gap-4 rounded-[4px] border border-[#ff6b6b]/40 px-3 py-2.5 text-[13.5px]">
            <span className="text-[#ff8a8a]">{turn.error}</span>
            <button type="button" onClick={onRetry} className="ln text-paper/80">
              Try again
            </button>
          </div>
        )}
        {turn.status === "stopped" && <p className="mt-3 text-[12.5px] text-paper/40">Stopped.</p>}
        {turn.status === "done" && turn.answer && (
          <div className="mt-6 flex gap-4 text-[12px] text-paper/50">
            <button type="button" className="hover:text-paper" onClick={() => navigator.clipboard?.writeText(turn.answer)}>
              Copy
            </button>
            <button type="button" className="hover:text-paper" onClick={onRetry}>
              Ask again
            </button>
          </div>
        )}
      </div>
      <aside className="order-3 lg:sticky lg:top-20 lg:self-start">
        <Sources sources={turn.sources} cited={cited} />
      </aside>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/80 p-4 pt-[8vh] backdrop-blur-sm" onMouseDown={onClose}>
      <div className="w-full max-w-lg rounded-[6px] border border-ash-3 bg-ash-1 p-5" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="text-[13px] text-paper/60 hover:text-paper">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function SettingsPanel({ settings, setSettings, access, onAccess, onClear }: {
  settings: Settings;
  setSettings: (s: Settings) => void;
  access: { code: string; group: string };
  onAccess: (a: { code: string; group: string }) => void;
  onClear: () => void;
}) {
  const engine = settings.engine;
  const p = engine !== "azaad" ? provider(engine) : null;
  const [key, setKey] = useState(p ? loadKey(p.id) : "");
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (p) setKey(loadKey(p.id));
  }, [engine]); // eslint-disable-line react-hooks/exhaustive-deps

  const field = "w-full rounded-[4px] border border-ash-3 bg-ink px-3 py-2 text-[13.5px] text-paper placeholder:text-paper/30 focus:border-paper/60 focus:outline-none";
  return (
    <div className="flex flex-col gap-6 text-[13.5px]">
      <div className="flex flex-col gap-2">
        <p className="label">Model</p>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() => setSettings({ ...settings, engine: "azaad" })}
            className={`col-span-2 rounded-[4px] border px-3 py-2.5 text-left ${engine === "azaad" ? "border-paper bg-paper/[0.06]" : "border-ash-3 hover:border-ash-4"}`}
          >
            <span className="flex items-center gap-2 font-semibold">
              <Dome className="h-3.5" /> Azaad
            </span>
            <span className="mt-0.5 block text-[12.5px] text-paper/60">Bunga Azaadi's own model. Free, no key, shows its line of research.</span>
          </button>
          {PROVIDERS.map((x) => (
            <button
              key={x.id}
              type="button"
              onClick={() => setSettings({ ...settings, engine: x.id })}
              className={`rounded-[4px] border px-3 py-2 text-left text-[12.5px] ${engine === x.id ? "border-paper bg-paper/[0.06]" : "border-ash-3 text-paper/80 hover:border-ash-4"}`}
            >
              {x.label}
            </button>
          ))}
        </div>
        {p && <p className="text-[12px] text-paper/50">Your own model answers; Azaad still supplies the passages from the library. Keys stay in this browser and go only to {p.label}.</p>}
      </div>

      {p && (
        <div className="flex flex-col gap-3">
          {p.needsKey && (
            <label className="flex flex-col gap-1.5">
              <span className="flex items-center justify-between text-[12px] text-paper/60">
                API key
                {p.keyUrl && (
                  <a href={p.keyUrl} target="_blank" rel="noreferrer" className="ln">
                    Get a key
                  </a>
                )}
              </span>
              <div className="flex gap-1.5">
                <input
                  type={show ? "text" : "password"}
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    saveKey(p.id, e.target.value.trim());
                  }}
                  placeholder="Paste key"
                  className={field}
                  autoComplete="off"
                />
                <button type="button" onClick={() => setShow(!show)} className="shrink-0 rounded-[4px] border border-ash-3 px-3 text-[12px] text-paper/70 hover:text-paper">
                  {show ? "Hide" : "Show"}
                </button>
              </div>
            </label>
          )}
          {(p.id === "custom" || p.id === "ollama") && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] text-paper/60">Endpoint URL</span>
              <input
                value={settings.baseUrls[p.id] ?? p.baseUrl ?? ""}
                onChange={(e) => setSettings({ ...settings, baseUrls: { ...settings.baseUrls, [p.id]: e.target.value } })}
                placeholder="https://…/v1"
                className={field}
              />
              {p.id === "ollama" && <span className="text-[11.5px] text-paper/45">Start Ollama with OLLAMA_ORIGINS={location.origin} so this page can reach it.</span>}
            </label>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] text-paper/60">Model</span>
            <input
              value={settings.models[p.id] ?? ""}
              onChange={(e) => setSettings({ ...settings, models: { ...settings.models, [p.id]: e.target.value } })}
              placeholder={p.placeholder}
              className={field}
            />
          </label>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <p className="label">Internal access</p>
        <Internal access={access} onAccess={onAccess} compact />
      </div>

      <div className="flex items-center justify-between border-t border-ash-3 pt-4 text-[12px] text-paper/50">
        <span>Conversations are stored only in this browser.</span>
        <button type="button" onClick={onClear} className="hover:text-[#ff8a8a]">
          Clear history
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function Ask({ route, settings, setSettings, access, onAccess, pending, clearPending }: {
  route: string;
  settings: Settings;
  setSettings: (s: Settings) => void;
  access: { code: string; group: string };
  onAccess: (a: { code: string; group: string }) => void;
  pending: string;
  clearPending: () => void;
}) {
  const [convos, setConvos] = useState<Conversation[]>(loadConversations);
  const [activeId, setActiveId] = useState<string>(() => loadConversations()[0]?.id ?? "");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [waking, setWaking] = useState<"" | "waking" | "warm">("");
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const active = convos.find((c) => c.id === activeId);
  const research = Boolean(access.code) && settings.research;
  const engineLabel = settings.engine === "azaad" ? `Azaad · ${research ? "Research" : "Public"}` : `${provider(settings.engine).label} · ${settings.models[settings.engine] || provider(settings.engine).placeholder}`;

  useEffect(() => {
    saveConversations(convos);
  }, [convos]);

  // Wake the GPU worker as soon as someone opens the console.
  useEffect(() => {
    if (settings.engine !== "azaad") return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const s = await status();
        if (stop) return;
        if (s.warm) {
          setWaking("warm");
          return;
        }
        setWaking("waking");
        warm();
      } catch {
        /* gateway unreachable; the send path will report it */
      }
      timer = setTimeout(poll, 8000);
    };
    poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [settings.engine]);

  const patchTurn = useCallback((cid: string, tid: string, fn: (t: Turn) => Turn) => {
    setConvos((cs) => cs.map((c) => (c.id === cid ? { ...c, updated: Date.now(), turns: c.turns.map((t) => (t.id === tid ? fn(t) : t)) } : c)));
  }, []);

  const send = useCallback(
    async (text: string, opts: { replaceTurn?: string; fresh?: boolean } = {}) => {
      const q = text.trim();
      if (!q || busy) return;
      setInput("");
      let cid = opts.fresh ? "" : activeId;
      let history: Turn[] = [];
      const base = convos.find((c) => c.id === cid);
      if (!base) {
        cid = uid();
        setConvos((cs) => [{ id: cid, title: q.slice(0, 80), turns: [], updated: Date.now() }, ...cs]);
        setActiveId(cid);
      } else {
        history = base.turns.filter((t) => t.status === "done" && t.id !== opts.replaceTurn);
      }
      const byok = settings.engine !== "azaad";
      const turn: Turn = {
        id: uid(),
        q,
        answer: "",
        reasoning: "",
        trace: [],
        sources: [],
        tier: byok ? "byok" : research ? "research" : "public",
        model: byok ? settings.models[settings.engine as ProviderId] || provider(settings.engine as ProviderId).placeholder : research ? "azaad-research" : "azaad",
        council: settings.council,
        status: "running",
        started: Date.now(),
      };
      setConvos((cs) =>
        cs.map((c) =>
          c.id === cid ? { ...c, updated: Date.now(), turns: opts.replaceTurn ? c.turns.map((t) => (t.id === opts.replaceTurn ? turn : t)) : [...c.turns, turn] } : c,
        ),
      );
      setBusy(true);
      const ac = new AbortController();
      abortRef.current = ac;
      const messages: ChatMsg[] = [...history.flatMap((t) => [{ role: "user" as const, content: t.q }, { role: "assistant" as const, content: t.answer }]), { role: "user", content: q }];

      // Batch token updates per frame so long answers stay smooth.
      let tok = "";
      let rsn = "";
      let raf = 0;
      const flush = () => {
        raf = 0;
        const a = tok;
        const r = rsn;
        tok = "";
        rsn = "";
        patchTurn(cid, turn.id, (t) => ({ ...t, answer: t.answer + a, reasoning: t.reasoning + r }));
      };
      const queue = () => {
        if (!raf) raf = requestAnimationFrame(flush);
      };

      try {
        if (!byok) {
          await streamAzaad(
            { messages, council: settings.council, mode: research ? "research" : "public", code: access.code || undefined, signal: ac.signal },
            {
              onTrace: (s) => patchTurn(cid, turn.id, (t) => ({ ...t, trace: [...t.trace, s] })),
              onSources: (s) => patchTurn(cid, turn.id, (t) => ({ ...t, sources: s })),
              onReasoning: (r) => {
                rsn += r;
                queue();
              },
              onToken: (x) => {
                tok += x;
                queue();
              },
            },
          );
          setWaking("warm");
        } else {
          const p = settings.engine as ProviderId;
          const t0 = Date.now();
          const step = (s: Omit<TraceStep, "ms">) => patchTurn(cid, turn.id, (t) => ({ ...t, trace: [...t.trace, { ...s, ms: Date.now() - t0 } as TraceStep] }));
          const prior = history.slice(-1).map((t) => t.q);
          const query = [...prior, q, q].join(" ");
          step({ step: "plan", title: "Understood the question", queries: [q] });
          const res = await search(query, access.code || undefined, research ? 16 : 10);
          step({ step: "search", title: res.tier === "research" ? "Searched the repository" : "Searched the papers", searches: [{ query: q, found: [...new Set(res.sources.map((s) => s.title))].slice(0, 4) }] });
          step({ step: "read", title: `Reading ${res.sources.length} passages`, documents: [...new Set(res.sources.map((s) => s.title))] });
          patchTurn(cid, turn.id, (t) => ({ ...t, sources: res.sources }));
          step({ step: "reason", title: "Answering" });
          await streamByok({
            provider: p,
            model: settings.models[p] || provider(p).placeholder,
            apiKey: loadKey(p) || undefined,
            baseUrl: settings.baseUrls[p],
            system: `${persona}\n\n${settings.council ? council : ""}\n\n## LIBRARY EXCERPTS\n\n${res.excerpts}`,
            messages,
            signal: ac.signal,
            onToken: (x) => {
              tok += x;
              queue();
            },
          });
        }
        if (raf) cancelAnimationFrame(raf);
        flush();
        patchTurn(cid, turn.id, (t) => ({ ...t, status: "done", ms: Date.now() - t.started }));
      } catch (e) {
        if (raf) cancelAnimationFrame(raf);
        flush();
        const aborted = (e as Error).name === "AbortError";
        let msg = (e as Error).message;
        if (!aborted && /Failed to fetch|NetworkError/i.test(msg)) msg = byok ? "Couldn't reach the provider. Check the key, the model name and, for local servers, CORS." : "Couldn't reach Azaad. Check your connection and try again.";
        patchTurn(cid, turn.id, (t) => ({ ...t, status: aborted ? "stopped" : "error", error: aborted ? undefined : msg }));
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [activeId, access.code, busy, convos, patchTurn, research, settings],
  );

  // A question typed on the home page.
  useEffect(() => {
    if (pending && !busy) {
      clearPending();
      send(pending, { fresh: true });
    }
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [active?.turns.length]);

  useEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
    }
  }, [input]);

  const newChat = () => {
    abortRef.current?.abort();
    setActiveId("");
    setShowHistory(false);
    taRef.current?.focus();
  };

  return (
    <div className="flex min-h-screen flex-col bg-ink">
      <Header route={route} solid />
      <div className="flex flex-1 pt-14">
        {/* History */}
        <aside className={`${showHistory ? "fixed inset-0 top-14 z-20 block bg-ink" : "hidden"} w-full shrink-0 border-r border-ash-3 md:sticky md:top-14 md:block md:h-[calc(100vh-56px)] md:w-60`}>
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="label text-paper/60">History</span>
              <button type="button" onClick={newChat} className="text-[12.5px] font-semibold hover:text-paper/70">
                New
              </button>
            </div>
            <ul className="flex-1 overflow-y-auto px-2 pb-4">
              {convos.map((c) => (
                <li key={c.id} className="group flex items-center">
                  <button
                    type="button"
                    onClick={() => {
                      setActiveId(c.id);
                      setShowHistory(false);
                    }}
                    className={`min-w-0 flex-1 truncate rounded-[3px] px-2 py-1.5 text-left text-[12.5px] ${c.id === activeId ? "bg-paper/[0.08] text-paper" : "text-paper/65 hover:text-paper"}`}
                  >
                    {c.title}
                  </button>
                  <button
                    type="button"
                    aria-label="Delete conversation"
                    onClick={() => {
                      setConvos((cs) => cs.filter((x) => x.id !== c.id));
                      if (c.id === activeId) setActiveId("");
                    }}
                    className="px-1.5 text-[12px] text-paper/30 opacity-0 hover:text-paper group-hover:opacity-100"
                  >
                    ×
                  </button>
                </li>
              ))}
              {!convos.length && <li className="px-2 text-[12px] text-paper/35">Nothing yet.</li>}
            </ul>
            <div className="border-t border-ash-3 px-4 py-3 text-[12px] text-paper/50">
              <button type="button" onClick={() => setShowSettings(true)} className="hover:text-paper">
                Settings
              </button>
            </div>
          </div>
        </aside>

        {/* Thread */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 px-4 sm:px-6">
            {active && active.turns.length ? (
              active.turns.map((t) => <Exchange key={t.id} turn={t} onRetry={() => send(t.q, { replaceTurn: t.id })} />)
            ) : (
              <div className="mx-auto flex max-w-[680px] flex-col gap-8 py-16 md:py-24">
                <Dome className="h-10 w-fit text-paper" />
                <h1 className="text-[44px] font-bold leading-[0.95] tracking-tightest md:text-[64px]">Ask Azaad.</h1>
                <p className="max-w-[520px] text-[15px] leading-[1.5] text-paper/70">
                  {research
                    ? `Research access for ${access.group}. Azaad searches the whole Vichaar Repository, checks its coverage, and searches again before it answers.`
                    : "Azaad answers from Bunga Azaadi's four papers. You'll see its line of research as it works, and every claim is cited to its source."}
                </p>
                <ul className="flex flex-col gap-2.5 text-[15px]">
                  {SUGGESTIONS.map((s) => (
                    <li key={s}>
                      <button type="button" onClick={() => send(s)} className="group inline-flex items-baseline gap-2 text-left text-paper/85 hover:text-paper">
                        <span className="underline decoration-paper/30 decoration-dotted underline-offset-4 group-hover:decoration-paper">{s}</span>
                        <Arrow className="h-[9px] w-[9px] shrink-0 opacity-50" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div ref={endRef} className="h-4" />
          </div>

          {/* Composer */}
          <div className="sticky bottom-0 border-t border-ash-3 bg-ink/95 px-4 pb-4 pt-3 backdrop-blur sm:px-6">
            <div className="mx-auto max-w-[760px]">
              {waking === "waking" && settings.engine === "azaad" && (
                <p className="mb-2 flex items-center gap-2 text-[12px] text-paper/55">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue" />
                  Waking Azaad's GPU. The first answer after a quiet spell takes about a minute.
                </p>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  send(input);
                }}
                className="flex items-end gap-3 rounded-[6px] border border-ash-3 bg-ash-1 px-3 py-2.5 focus-within:border-paper/50"
              >
                <textarea
                  ref={taRef}
                  rows={1}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send(input);
                    }
                  }}
                  placeholder={active?.turns.length ? "Follow up…" : "Ask a question…"}
                  className="max-h-[220px] min-h-[24px] flex-1 resize-none bg-transparent text-[15px] leading-[1.5] text-paper placeholder:text-paper/35 focus:outline-none"
                  aria-label="Message"
                />
                {busy ? (
                  <button type="button" onClick={() => abortRef.current?.abort()} className="shrink-0 rounded-[4px] border border-paper/40 px-3 py-1 text-[12.5px] font-semibold hover:bg-paper/10">
                    Stop
                  </button>
                ) : (
                  <button type="submit" disabled={!input.trim()} className="shrink-0 rounded-[4px] bg-paper px-3 py-1 text-[12.5px] font-semibold text-ink disabled:opacity-30">
                    Ask
                  </button>
                )}
              </form>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[12px] text-paper/55">
                <div className="flex items-center gap-4">
                  <label className="flex cursor-pointer items-center gap-1.5 hover:text-paper">
                    <input type="checkbox" checked={settings.council} onChange={(e) => setSettings({ ...settings, council: e.target.checked })} className="accent-[#003cff]" />
                    Council
                  </label>
                  {access.code && (
                    <label className="flex cursor-pointer items-center gap-1.5 hover:text-paper">
                      <input type="checkbox" checked={settings.research} onChange={(e) => setSettings({ ...settings, research: e.target.checked })} className="accent-[#003cff]" />
                      Research
                    </label>
                  )}
                  <button type="button" className="md:hidden" onClick={() => setShowHistory(!showHistory)}>
                    History
                  </button>
                </div>
                <button type="button" onClick={() => setShowSettings(true)} className="hover:text-paper">
                  {engineLabel}
                </button>
              </div>
            </div>
          </div>
        </main>
      </div>

      {showSettings && (
        <Modal title="Settings" onClose={() => setShowSettings(false)}>
          <SettingsPanel
            settings={settings}
            setSettings={setSettings}
            access={access}
            onAccess={onAccess}
            onClear={() => {
              setConvos([]);
              setActiveId("");
            }}
          />
        </Modal>
      )}
    </div>
  );
}
