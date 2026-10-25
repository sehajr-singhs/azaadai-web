import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  BookOpen,
  Check,
  Cloud,
  Copy,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  Loader2,
  Menu,
  Moon,
  PanelLeftClose,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Square,
  Sun,
  Trash2,
  Users,
} from "lucide-react";
import { Badge, Button, cn, Dialog, Input, Label, Select, Switch } from "./components/ui";
import { Index, loadLibrary, type Library } from "./lib/library";
import { AZAAD_CLOUD_URL, hasWebGPU, listModels, provider, PROVIDERS, streamChat, type ProviderId } from "./lib/providers";
import {
  buildSystem,
  loadConversations,
  loadKeys,
  loadSettings,
  newId,
  saveConversations,
  saveKeys,
  saveSettings,
  sourcesFrom,
  type Conversation,
  type Message,
  type Settings,
  type Source,
} from "./lib/store";

const REPO_URL = "https://github.com/sehajr-singhs/azaadai-web";

const SUGGESTIONS = [
  { kicker: "Raajniti Vidya", q: "What is the difference between Khalistan and Khalsa Raaj, and why does it matter?" },
  { kicker: "Khalsanama", q: "Explain why the Khalsa is the Guru, with Gurbani and history." },
  { kicker: "Khalsa Revival", q: "Walk me through the three stages of the Dharam Yudh Pipeline." },
  { kicker: "Azadism", q: "How does the Azadist Manifesto handle taxes, welfare and safety nets?" },
];

type LibState = { status: "loading" | "ready" | "error"; done: number; total: number; label: string; lib?: Library; error?: string };

export default function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [keys, setKeys] = useState(loadKeys);
  const [convs, setConvs] = useState<Conversation[]>(loadConversations);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [lib, setLib] = useState<LibState>({ status: "loading", done: 0, total: 0, label: "Connecting to bungaazaadi.com" });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [dialog, setDialog] = useState<null | "settings" | "library" | "about">(null);
  const [drawer, setDrawer] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => saveConversations(convs), [convs]);
  useEffect(() => saveKeys(keys, settings.rememberKeys), [keys, settings.rememberKeys]);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("azaad.theme", dark ? "dark" : "light");
    } catch {
      /* ignore */
    }
  }, [dark]);

  const reloadLibrary = useCallback((force = false) => {
    setLib((l) => ({ ...l, status: "loading", done: 0 }));
    loadLibrary((done, total, label) => setLib((l) => ({ ...l, done, total, label })), force)
      .then((lib) => setLib({ status: "ready", done: 1, total: 1, label: "", lib }))
      .catch((e) => setLib({ status: "error", done: 0, total: 0, label: "", error: String(e) }));
  }, []);
  useEffect(() => reloadLibrary(), [reloadLibrary]);

  const index = useMemo(() => (lib.lib ? new Index(lib.lib) : null), [lib.lib]);
  const active = convs.find((c) => c.id === activeId) ?? null;
  const info = provider(settings.provider);
  const model = settings.models[settings.provider] ?? info.models[0] ?? "";

  const patchActive = (id: string, fn: (c: Conversation) => Conversation) => setConvs((cs) => cs.map((c) => (c.id === id ? fn(c) : c)));

  async function send(text: string) {
    text = text.trim();
    if (!text || busy) return;
    if (info.needsKey && !keys[settings.provider]) {
      setDialog("settings");
      return;
    }
    if (!model) {
      setDialog("settings");
      return;
    }
    let conv = active;
    if (!conv) {
      conv = { id: newId(), title: text.slice(0, 60), messages: [], updated: Date.now() };
      setConvs((cs) => [conv!, ...cs]);
      setActiveId(conv.id);
    }
    const id = conv.id;
    const history = [...conv.messages, { role: "user", content: text } as Message];
    const priorUser = conv.messages.filter((m) => m.role === "user").slice(-1).map((m) => m.content);
    const hits = index ? index.search([...priorUser, text, text].join(" "), info.hits) : [];
    const sources = sourcesFrom(hits);
    const system = buildSystem(hits, info.budget, settings.council);

    patchActive(id, (c) => ({ ...c, messages: [...history, { role: "assistant", content: "", sources, model }], updated: Date.now() }));
    setBusy(true);
    setStatus("");
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Batch tokens into one state update per frame.
    let acc = "";
    let raf = 0;
    const flush = () => {
      raf = 0;
      const shown = acc.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trimStart();
      patchActive(id, (c) => {
        const m = [...c.messages];
        m[m.length - 1] = { ...m[m.length - 1], content: shown };
        return { ...c, messages: m };
      });
    };
    try {
      await streamChat({
        provider: settings.provider,
        model,
        apiKey: keys[settings.provider],
        baseUrl: settings.baseUrls[settings.provider],
        system,
        messages: history.slice(-12).map((m) => ({ role: m.role, content: m.content })),
        signal: ctrl.signal,
        onStatus: setStatus,
        onToken: (t) => {
          if (acc === "") setStatus("");
          acc += t;
          if (!raf) raf = requestAnimationFrame(flush);
        },
      });
    } catch (e) {
      if (!ctrl.signal.aborted) {
        const msg = e instanceof Error ? e.message : String(e);
        patchActive(id, (c) => {
          const m = [...c.messages];
          m[m.length - 1] = { ...m[m.length - 1], error: corsHint(settings.provider, msg) };
          return { ...c, messages: m };
        });
      }
    } finally {
      cancelAnimationFrame(raf);
      flush();
      setBusy(false);
      setStatus("");
      abortRef.current = null;
    }
  }

  const sidebar = (
    <Sidebar
      convs={convs}
      activeId={activeId}
      lib={lib}
      dark={dark}
      onNew={() => {
        setActiveId(null);
        setDrawer(false);
      }}
      onPick={(id) => {
        setActiveId(id);
        setDrawer(false);
      }}
      onDelete={(id) => {
        setConvs((cs) => cs.filter((c) => c.id !== id));
        if (id === activeId) setActiveId(null);
      }}
      onDialog={(d) => {
        setDialog(d);
        setDrawer(false);
      }}
      onTheme={() => setDark((d) => !d)}
      onClose={() => setDrawer(false)}
    />
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-[17rem] shrink-0 border-r bg-secondary/40 md:flex">{sidebar}</aside>
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-[17rem] border-r bg-background">{sidebar}</aside>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar
          settings={settings}
          setSettings={setSettings}
          model={model}
          onMenu={() => setDrawer(true)}
          onSettings={() => setDialog("settings")}
        />
        <Thread conv={active} busy={busy} status={status} lib={lib} onAsk={send} />
        <Composer busy={busy} onSend={send} onStop={() => abortRef.current?.abort()} settings={settings} setSettings={setSettings} />
      </main>

      <SettingsDialog
        open={dialog === "settings"}
        onClose={() => setDialog(null)}
        settings={settings}
        setSettings={setSettings}
        keys={keys}
        setKeys={setKeys}
        onClear={() => {
          try {
            localStorage.clear();
            sessionStorage.clear();
            indexedDB.deleteDatabase("azaadai");
          } catch {
            /* ignore */
          }
          location.reload();
        }}
      />
      <LibraryDialog open={dialog === "library"} onClose={() => setDialog(null)} lib={lib} index={index} onReload={() => reloadLibrary(true)} />
      <AboutDialog open={dialog === "about"} onClose={() => setDialog(null)} />
    </div>
  );
}

function corsHint(p: ProviderId, msg: string): string {
  if (!/Failed to fetch|NetworkError|Load failed/i.test(msg)) return msg;
  if (p === "ollama") return "Couldn't reach Ollama. Start it with OLLAMA_ORIGINS set to this site's address (see Settings).";
  if (p === "azaad-cloud") return "Couldn't reach Azaad-1 Cloud. It may be waking up; try again in a minute.";
  return `${msg}. The provider blocked the request from the browser, or the network is down.`;
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function Mark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center justify-center rounded-lg bg-primary font-display text-[1.35rem] leading-none text-primary-foreground", className)}>
      a<span className="text-gold">.</span>
    </div>
  );
}

function Sidebar(p: {
  convs: Conversation[];
  activeId: string | null;
  lib: LibState;
  dark: boolean;
  onNew: () => void;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
  onDialog: (d: "settings" | "library" | "about") => void;
  onTheme: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex w-full flex-col">
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <Mark className="h-8 w-8" />
        <div className="leading-tight">
          <div className="font-display text-xl tracking-tight">AzaadAI</div>
          <div className="font-mono text-[0.68rem] uppercase tracking-wider text-muted-foreground">Azadist counsel</div>
        </div>
        <Button variant="ghost" size="icon" className="ml-auto h-8 w-8 md:hidden" onClick={p.onClose} aria-label="Close sidebar">
          <PanelLeftClose />
        </Button>
      </div>
      <div className="px-3">
        <Button variant="outline" className="w-full justify-start" onClick={p.onNew}>
          <Plus /> New chat
        </Button>
      </div>
      <div className="mt-4 px-4 font-mono text-[0.68rem] uppercase tracking-wider text-muted-foreground">Chats</div>
      <nav className="scroll-thin mt-1 flex-1 overflow-y-auto px-2">
        {p.convs.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">No chats yet. They stay in this browser.</p>}
        {p.convs.map((c) => (
          <div
            key={c.id}
            className={cn(
              "group flex items-center rounded-md text-sm transition-colors hover:bg-accent",
              c.id === p.activeId && "bg-accent font-medium",
            )}
          >
            <button className="min-w-0 flex-1 truncate px-2 py-1.5 text-left" onClick={() => p.onPick(c.id)}>
              {c.title}
            </button>
            <button
              className="mr-1 rounded p-1 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
              onClick={() => p.onDelete(c.id)}
              aria-label="Delete chat"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
      </nav>
      <div className="space-y-1 border-t p-3">
        <button onClick={() => p.onDialog("library")} className="w-full rounded-lg border bg-background p-3 text-left shadow-sm transition-colors hover:bg-accent">
          <div className="flex items-center gap-2 text-sm font-medium">
            <BookOpen className="size-4 text-gold" /> Library
            {p.lib.status === "loading" && <Loader2 className="ml-auto size-3.5 animate-spin text-muted-foreground" />}
            {p.lib.status === "ready" && <span className="ml-auto h-2 w-2 rounded-full bg-emerald-500" />}
            {p.lib.status === "error" && <span className="ml-auto h-2 w-2 rounded-full bg-destructive" />}
          </div>
          <div className="mt-1 font-mono text-[0.7rem] text-muted-foreground">
            {p.lib.status === "ready" && `${p.lib.lib!.docs.length} vichaars · ${p.lib.lib!.chunks.length.toLocaleString()} passages`}
            {p.lib.status === "loading" && (p.lib.total ? `Loading ${p.lib.done}/${p.lib.total}` : "Connecting…")}
            {p.lib.status === "error" && "Couldn't load. Tap to retry."}
          </div>
          {p.lib.status === "loading" && p.lib.total > 0 && (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-secondary">
              <div className="h-full bg-gold transition-all" style={{ width: `${(100 * p.lib.done) / p.lib.total}%` }} />
            </div>
          )}
        </button>
        <div className="flex items-center gap-1 pt-1">
          <Button variant="ghost" size="sm" className="flex-1 justify-start" onClick={() => p.onDialog("settings")}>
            <Settings2 /> Settings
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => p.onDialog("about")} aria-label="About">
            <Info />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={p.onTheme} aria-label="Toggle theme">
            {p.dark ? <Sun /> : <Moon />}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

function TopBar(p: { settings: Settings; setSettings: (s: Settings) => void; model: string; onMenu: () => void; onSettings: () => void }) {
  const { settings, setSettings } = p;
  const info = provider(settings.provider);
  const Icon = settings.provider === "azaad-cloud" ? Cloud : settings.provider === "azaad-local" ? Cpu : KeyRound;
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
      <Button variant="ghost" size="icon" className="md:hidden" onClick={p.onMenu} aria-label="Open sidebar">
        <Menu />
      </Button>
      <Icon className="hidden size-4 text-muted-foreground sm:block" />
      <Select
        aria-label="Provider"
        value={settings.provider}
        onChange={(v) => setSettings({ ...settings, provider: v as ProviderId })}
        className="w-[10.5rem] sm:w-48"
      >
        <optgroup label="Azaad-1 (no key)">
          {PROVIDERS.filter((x) => x.id.startsWith("azaad")).map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Bring your own">
          {PROVIDERS.filter((x) => !x.id.startsWith("azaad")).map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </optgroup>
      </Select>
      {settings.provider !== "azaad-cloud" && (
        <button onClick={p.onSettings} className="hidden h-9 min-w-0 max-w-[16rem] items-center truncate rounded-md border border-dashed px-3 font-mono text-xs text-muted-foreground hover:bg-accent sm:flex">
          {p.model || "choose a model…"}
        </button>
      )}
      <div className="ml-auto flex items-center gap-2">
        {info.needsKey && <Badge tone="outline" className="hidden lg:inline-flex">key stays in your browser</Badge>}
        <Button variant="ghost" size="icon" onClick={p.onSettings} aria-label="Settings">
          <Settings2 />
        </Button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

function Thread(p: { conv: Conversation | null; busy: boolean; status: string; lib: LibState; onAsk: (q: string) => void }) {
  const end = useRef<HTMLDivElement>(null);
  const last = p.conv?.messages.at(-1)?.content.length;
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [p.conv?.id, p.conv?.messages.length, last]);

  if (!p.conv || p.conv.messages.length === 0) return <Hero lib={p.lib} onAsk={p.onAsk} />;
  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 pb-10 pt-6 sm:px-6">
        {p.conv.messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="mb-6 flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-[0.95rem]">{m.content}</div>
            </div>
          ) : (
            <AssistantMessage key={i} m={m} streaming={p.busy && i === p.conv!.messages.length - 1} status={p.status} />
          ),
        )}
        <div ref={end} />
      </div>
    </div>
  );
}

function Hero({ lib, onAsk }: { lib: LibState; onAsk: (q: string) => void }) {
  return (
    <div className="scroll-thin flex flex-1 overflow-y-auto">
      <div className="m-auto w-full max-w-3xl px-4 py-10 sm:px-6">
        <div className="font-gurmukhi text-sm tracking-wide text-gold">ਨਮੋ ਸ੍ਰੀ ਗੁਰੂ ਖ਼ਾਲਸਾ</div>
        <h1 className="mt-3 font-display text-5xl leading-[1.05] tracking-tight sm:text-6xl">
          Counsel from the <em className="text-link">Vichaar</em>,<br className="hidden sm:block" /> cited to the source.
        </h1>
        <p className="mt-4 max-w-xl font-serif text-lg leading-relaxed text-muted-foreground">
          AzaadAI answers through the Azadist Manifesto, <i>Khalistan vs Khalsa Raaj</i>, <i>The Khalsa Is The Guru</i>, the Dharam Yudh Pipeline and the full
          Bunga Azaadi Vichaar Repository. Run Azaad-1 free, or plug in your own key.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
          <Badge tone="gold">LIBRARY</Badge>
          {lib.status === "ready" ? (
            <span>
              {lib.lib!.docs.length} vichaars · {lib.lib!.chunks.length.toLocaleString()} passages · live from bungaazaadi.com
            </span>
          ) : lib.status === "loading" ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="size-3 animate-spin" /> {lib.label}
            </span>
          ) : (
            <span className="text-destructive">couldn't reach bungaazaadi.com, answers won't be grounded</span>
          )}
        </div>
        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.q}
              onClick={() => onAsk(s.q)}
              className="group rounded-xl border bg-card p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md"
            >
              <div className="font-mono text-[0.68rem] uppercase tracking-wider text-link">{s.kicker}</div>
              <div className="mt-1.5 text-sm leading-snug">{s.q}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function withCitations(text: string, sources: Source[]): string {
  const valid = new Set(sources.map((s) => s.n));
  return text.replace(/\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g, (all, nums: string) => {
    const ns = nums.split(/\s*,\s*/).map(Number);
    if (!ns.every((n) => valid.has(n))) return all;
    return ns.map((n) => `[${n}](#cite-${n})`).join("");
  });
}

function AssistantMessage({ m, streaming, status }: { m: Message; streaming: boolean; status: string }) {
  const [copied, setCopied] = useState(false);
  const sources = m.sources ?? [];
  const cited = sources.filter((s) => new RegExp(`\\[(?:\\d+\\s*,\\s*)*${s.n}(?:\\s*,\\s*\\d+)*\\]`).test(m.content));
  const [showAll, setShowAll] = useState(false);
  const listed = showAll ? sources : cited;
  return (
    <div className="mb-8">
      <div className="mb-2 flex items-center gap-2">
        <Mark className="h-6 w-6 rounded-md text-base" />
        <span className="text-sm font-medium">Azaad</span>
        {m.model && <span className="truncate font-mono text-[0.7rem] text-muted-foreground">{m.model}</span>}
      </div>
      {m.content ? (
        <div className={cn("answer", streaming && "after:ml-0.5 after:inline-block after:h-4 after:w-1.5 after:animate-pulse after:bg-foreground/60 after:align-middle")}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => {
                const n = href?.startsWith("#cite-") ? Number(href.slice(6)) : 0;
                const s = sources.find((x) => x.n === n);
                if (s)
                  return (
                    <a className="cite" href={s.url} target="_blank" rel="noreferrer" title={`${s.title}${s.heading ? " · " + s.heading : ""}`}>
                      {n}
                    </a>
                  );
                return (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                );
              },
            }}
          >
            {withCitations(m.content, sources)}
          </ReactMarkdown>
        </div>
      ) : (
        !m.error && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {status || (sources.length ? `Reading ${sources.length} passages…` : "Thinking…")}
          </div>
        )
      )}
      {m.error && <div className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{m.error}</div>}
      {!streaming && m.content && (
        <div className="mt-4">
          {sources.length > 0 && (
            <div className="rounded-lg border bg-card">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <span className="font-mono text-[0.68rem] uppercase tracking-wider text-muted-foreground">
                  Sources · {cited.length} cited of {sources.length} read
                </span>
                {sources.length > cited.length && (
                  <button className="text-xs text-link hover:underline" onClick={() => setShowAll(!showAll)}>
                    {showAll ? "cited only" : "show all"}
                  </button>
                )}
              </div>
              <ol className="divide-y">
                {listed.map((s) => (
                  <li key={s.n}>
                    <a href={s.url} target="_blank" rel="noreferrer" className="group flex items-start gap-3 px-3 py-2 text-sm hover:bg-accent">
                      <span className="cite mt-0.5 shrink-0 align-baseline">{s.n}</span>
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{s.title}</span>
                        {s.heading && <span className="text-muted-foreground"> · {s.heading}</span>}
                      </span>
                      {s.core && <Badge tone="gold">core</Badge>}
                      <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
                    </a>
                  </li>
                ))}
                {listed.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">No inline citations in this answer.</li>}
              </ol>
            </div>
          )}
          <div className="mt-2 flex">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-muted-foreground"
              onClick={() => {
                navigator.clipboard?.writeText(m.content);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function Composer(p: { busy: boolean; onSend: (t: string) => void; onStop: () => void; settings: Settings; setSettings: (s: Settings) => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [text]);
  const submit = () => {
    if (!text.trim() || p.busy) return;
    p.onSend(text);
    setText("");
  };
  return (
    <div className="shrink-0 px-3 pb-3 sm:px-6 sm:pb-5">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-2xl border bg-card shadow-sm transition-shadow focus-within:shadow-md focus-within:ring-1 focus-within:ring-ring/40">
          <textarea
            ref={ref}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Ask Azaad anything…"
            className="block w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[0.95rem] outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center gap-2 px-2.5 pb-2.5">
            <button
              onClick={() => p.setSettings({ ...p.settings, council: !p.settings.council })}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
                p.settings.council ? "border-gold/40 bg-gold/10 text-gold" : "text-muted-foreground hover:bg-accent",
              )}
              title="Run the eight-voice council debate before answering"
            >
              <Users className="size-3.5" /> Council{p.settings.council && " · 8 voices"}
            </button>
            <div className="ml-auto">
              {p.busy ? (
                <Button size="icon" className="h-8 w-8 rounded-full" onClick={p.onStop} aria-label="Stop">
                  <Square className="size-3 fill-current" />
                </Button>
              ) : (
                <Button size="icon" className="h-8 w-8 rounded-full" onClick={submit} disabled={!text.trim()} aria-label="Send">
                  <ArrowUp />
                </Button>
              )}
            </div>
          </div>
        </div>
        <p className="mt-2 text-center text-[0.7rem] text-muted-foreground">
          Independent project built on Bunga Azaadi's public work, not an official Bunga Azaadi product. Check the cited source.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function SettingsDialog(p: {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  setSettings: (s: Settings) => void;
  keys: Partial<Record<ProviderId, string>>;
  setKeys: (k: Partial<Record<ProviderId, string>>) => void;
  onClear: () => void;
}) {
  const { settings, setSettings, keys, setKeys } = p;
  const id = settings.provider;
  const info = provider(id);
  const [show, setShow] = useState(false);
  const [models, setModels] = useState<string[]>(info.models);
  const [test, setTest] = useState<{ state: "idle" | "busy" | "ok" | "err"; msg?: string }>({ state: "idle" });

  useEffect(() => {
    setModels(info.models);
    setTest({ state: "idle" });
  }, [id, info.models]);

  const fetchModels = async () => {
    setTest({ state: "busy" });
    try {
      const m = await listModels(id, keys[id], settings.baseUrls[id]);
      setModels(m.length ? m : info.models);
      setTest({ state: "ok", msg: `${m.length} models available` });
      if (!settings.models[id] && m[0]) setSettings({ ...settings, models: { ...settings.models, [id]: m[0] } });
    } catch (e) {
      setTest({ state: "err", msg: corsHint(id, e instanceof Error ? e.message : String(e)) });
    }
  };

  const model = settings.models[id] ?? info.models[0] ?? "";
  const editableBase = id === "custom" || id === "ollama" || id === "azaad-cloud";

  return (
    <Dialog open={p.open} onClose={p.onClose} title="Model & keys" description="Pick where Azaad thinks. Keys are stored only in this browser and sent only to the provider you choose.">
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {PROVIDERS.map((x) => (
            <button
              key={x.id}
              onClick={() => setSettings({ ...settings, provider: x.id })}
              className={cn(
                "rounded-lg border p-2.5 text-left text-sm transition-colors hover:bg-accent",
                x.id === id && "border-foreground/40 bg-accent ring-1 ring-foreground/10",
              )}
            >
              <div className="flex items-center gap-1.5 font-medium">
                {x.id === "azaad-cloud" ? <Cloud className="size-3.5 text-gold" /> : x.id === "azaad-local" ? <Cpu className="size-3.5 text-gold" /> : null}
                <span className="truncate">{x.label.replace("Azaad-1 · ", "Azaad-1 ")}</span>
              </div>
              {keys[x.id] && <div className="mt-0.5 font-mono text-[0.65rem] text-emerald-600 dark:text-emerald-400">key saved</div>}
              {x.id.startsWith("azaad") && <div className="mt-0.5 font-mono text-[0.65rem] text-muted-foreground">free · no key</div>}
            </button>
          ))}
        </div>

        <p className="text-sm text-muted-foreground">{info.blurb}</p>

        {id === "azaad-local" && !hasWebGPU() && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">This browser has no WebGPU. Use desktop Chrome or Edge.</div>
        )}
        {id === "azaad-local" && (
          <div className="rounded-lg border bg-secondary/50 p-3 text-xs leading-relaxed text-muted-foreground">
            First run downloads the model once (about 2.5 GB for 4B, 1.3 GB for 2B, 5 GB for 9B) and caches it. After that it runs offline on your GPU and nothing leaves your device.
          </div>
        )}
        {id === "azaad-cloud" && !AZAAD_CLOUD_URL && !settings.baseUrls[id] && (
          <div className="rounded-lg border border-gold/30 bg-gold/5 p-3 text-xs text-gold">This build has no cloud endpoint configured. Paste one below.</div>
        )}

        {info.needsKey && (
          <div>
            <Label
              hint={
                info.keyUrl && (
                  <a className="text-link hover:underline" href={info.keyUrl} target="_blank" rel="noreferrer">
                    Get a key ↗
                  </a>
                )
              }
            >
              {info.label} API key
            </Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type={show ? "text" : "password"}
                  value={keys[id] ?? ""}
                  onChange={(e) => setKeys({ ...keys, [id]: e.target.value.trim() })}
                  placeholder="Paste your key"
                  className="pr-9 font-mono"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" onClick={() => setShow(!show)} aria-label="Show key">
                  {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>
          </div>
        )}

        {editableBase && (
          <div>
            <Label hint={id === "ollama" ? "default http://localhost:11434/v1" : undefined}>{id === "azaad-cloud" ? "Endpoint" : "Base URL"}</Label>
            <Input
              value={settings.baseUrls[id] ?? ""}
              onChange={(e) => setSettings({ ...settings, baseUrls: { ...settings.baseUrls, [id]: e.target.value.trim() } })}
              placeholder={info.baseUrl || "https://your-server/v1"}
              className="font-mono"
            />
            {id === "ollama" && (
              <p className="mt-1.5 font-mono text-[0.7rem] text-muted-foreground">
                OLLAMA_ORIGINS={location.origin} ollama serve
              </p>
            )}
          </div>
        )}
        {id === "custom" && (
          <div>
            <Label hint="optional">API key</Label>
            <Input type="password" value={keys[id] ?? ""} onChange={(e) => setKeys({ ...keys, [id]: e.target.value.trim() })} className="font-mono" />
          </div>
        )}

        {id !== "azaad-cloud" && (
          <div>
            <Label
              hint={
                id !== "azaad-local" && (
                  <button className="inline-flex items-center gap-1 text-link hover:underline" onClick={fetchModels}>
                    {test.state === "busy" ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />} load models
                  </button>
                )
              }
            >
              Model
            </Label>
            <Input
              list={`models-${id}`}
              value={model}
              onChange={(e) => setSettings({ ...settings, models: { ...settings.models, [id]: e.target.value } })}
              placeholder="model id"
              className="font-mono"
            />
            <datalist id={`models-${id}`}>
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            {test.state === "ok" && <p className="mt-1.5 text-xs text-emerald-600 dark:text-emerald-400">✓ Connected · {test.msg}</p>}
            {test.state === "err" && <p className="mt-1.5 text-xs text-destructive">{test.msg}</p>}
          </div>
        )}

        <div className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <div className="text-sm font-medium">Remember keys on this device</div>
            <div className="text-xs text-muted-foreground">Off: keys are forgotten when you close the tab.</div>
          </div>
          <Switch checked={settings.rememberKeys} onChange={(v) => setSettings({ ...settings, rememberKeys: v })} label="Remember keys" />
        </div>

        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" className="text-destructive" onClick={p.onClear}>
            <Trash2 /> Clear all local data
          </Button>
          <Button onClick={p.onClose}>Done</Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

function LibraryDialog(p: { open: boolean; onClose: () => void; lib: LibState; index: Index | null; onReload: () => void }) {
  const [q, setQ] = useState("");
  const hits = useMemo(() => (q.trim() && p.index ? p.index.search(q, 8) : []), [q, p.index]);
  const docs = p.lib.lib?.docs ?? [];
  const sections = useMemo(() => {
    const m = new Map<string, typeof docs>();
    for (const d of docs) m.set(d.section, [...(m.get(d.section) ?? []), d]);
    return [...m.entries()].sort();
  }, [docs]);
  return (
    <Dialog open={p.open} onClose={p.onClose} wide title="The Library" description="Loaded live from bungaazaadi.com, the Bunga Azaadi Vichaar Repository. Azaad retrieves the most relevant passages for each question.">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the library: try “sarbat khalsa” or “welfare”" className="pl-9" />
      </div>
      {q.trim() ? (
        <ol className="mt-4 space-y-2">
          {hits.map((h, i) => (
            <li key={h.chunk.id} className="rounded-lg border p-3">
              <a href={h.doc.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm font-medium hover:underline">
                <span className="cite align-baseline">{i + 1}</span> {h.doc.title}
                {h.chunk.heading !== h.doc.title && <span className="font-normal text-muted-foreground">· {h.chunk.heading}</span>}
                <span className="ml-auto font-mono text-[0.65rem] text-muted-foreground">{h.score.toFixed(1)}</span>
              </a>
              <p className="mt-1.5 line-clamp-3 font-serif text-sm text-muted-foreground">{h.chunk.text}</p>
            </li>
          ))}
          {hits.length === 0 && <li className="text-sm text-muted-foreground">No passages match.</li>}
        </ol>
      ) : (
        <div className="mt-5 space-y-5">
          {p.lib.status !== "ready" && (
            <p className="text-sm text-muted-foreground">{p.lib.status === "loading" ? `Loading… ${p.lib.label}` : p.lib.error}</p>
          )}
          <div>
            <div className="mb-2 font-mono text-[0.68rem] uppercase tracking-wider text-gold">Core papers</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {docs
                .filter((d) => d.core)
                .map((d) => (
                  <a key={d.path} href={d.url} target="_blank" rel="noreferrer" className="rounded-lg border bg-card p-3 text-sm shadow-sm hover:bg-accent">
                    <div className="font-medium">{d.title}</div>
                    <div className="mt-0.5 font-mono text-[0.68rem] text-muted-foreground">
                      {d.section} · {Math.round(d.chars / 1000)}k chars
                    </div>
                  </a>
                ))}
            </div>
          </div>
          {sections.map(([s, ds]) => (
            <div key={s}>
              <div className="mb-1.5 font-mono text-[0.68rem] uppercase tracking-wider text-muted-foreground">
                {s} · {ds.length}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {ds.map((d) => (
                  <a key={d.path} href={d.url} target="_blank" rel="noreferrer" className="rounded-md border px-2 py-1 text-xs hover:bg-accent">
                    {d.title}
                  </a>
                ))}
              </div>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={p.onReload}>
            <RefreshCw /> Re-sync from bungaazaadi.com
          </Button>
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const endpoint = AZAAD_CLOUD_URL || "https://<your-modal-endpoint>";
  const curl = `curl -N ${endpoint}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"azaad-1","stream":true,
       "messages":[{"role":"user","content":"What is Khalsa Raaj?"}]}'`;
  return (
    <Dialog open={open} onClose={onClose} title="About AzaadAI" description="How it works, and how to build on it.">
      <div className="space-y-4 text-sm leading-relaxed">
        <div className="grid gap-2">
          {[
            [Cloud, "Azaad-1 Cloud", "Qwen3.5-9B on a serverless GPU (Modal) with the whole library indexed server-side. Free to use, no key. Scales to zero, so the first message after a quiet spell takes about a minute."],
            [Cpu, "Azaad-1 On-device", "The same Azaad persona and retrieval with Qwen3.5 running in your browser on WebGPU. Nothing leaves your machine."],
            [KeyRound, "Bring your own key", "Claude, GPT, Gemini, Groq, OpenRouter, Ollama or any OpenAI-compatible server. Requests go from your browser straight to that provider."],
          ].map(([Icon, t, d]) => {
            const I = Icon as typeof Cloud;
            return (
              <div key={t as string} className="flex gap-3 rounded-lg border p-3">
                <I className="mt-0.5 size-4 shrink-0 text-gold" />
                <div>
                  <div className="font-medium">{t as string}</div>
                  <div className="text-muted-foreground">{d as string}</div>
                </div>
              </div>
            );
          })}
        </div>
        <p className="text-muted-foreground">
          Every answer is grounded in passages retrieved from the Vichaar Repository and cited inline. Click a citation to read the original on bungaazaadi.com.
        </p>
        <div>
          <div className="mb-1.5 font-mono text-[0.68rem] uppercase tracking-wider text-muted-foreground">Azaad-1 API (OpenAI-compatible)</div>
          <pre className="scroll-thin overflow-x-auto rounded-lg border bg-secondary/60 p-3 font-mono text-xs leading-relaxed">{curl}</pre>
        </div>
        <p className="text-xs text-muted-foreground">
          Independent, open-source project built on the public work of Bunga Azaadi (Institute for Azadist Studies). Not an official Bunga Azaadi product. All
          library text belongs to its authors and is fetched live from{" "}
          <a className="text-link hover:underline" href="https://bungaazaadi.com" target="_blank" rel="noreferrer">
            bungaazaadi.com
          </a>
          . Source code on{" "}
          <a className="text-link hover:underline" href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
          .
        </p>
      </div>
    </Dialog>
  );
}
