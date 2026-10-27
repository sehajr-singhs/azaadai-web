import type { Source, TraceStep } from "./api";
import type { ProviderId } from "./providers";

export interface Turn {
  id: string;
  q: string;
  answer: string;
  reasoning: string;
  trace: TraceStep[];
  sources: Source[];
  tier: "public" | "research" | "byok";
  model: string;
  council: boolean;
  status: "running" | "done" | "error" | "stopped";
  error?: string;
  started: number;
  ms?: number;
}

export interface Conversation {
  id: string;
  title: string;
  turns: Turn[];
  updated: number;
}

export interface Settings {
  engine: "azaad" | ProviderId;
  models: Partial<Record<ProviderId, string>>;
  baseUrls: Partial<Record<ProviderId, string>>;
  council: boolean;
  research: boolean; // only honoured with a valid access code
}

const DEFAULTS: Settings = { engine: "azaad", models: {}, baseUrls: {}, council: false, research: true };

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked */
  }
}

export const loadSettings = () => read<Settings>("azaad.settings.v2", DEFAULTS);
export const saveSettings = (s: Settings) => write("azaad.settings.v2", s);

export const loadAccess = () => read<{ code: string; group: string }>("azaad.access", { code: "", group: "" });
export const saveAccess = (a: { code: string; group: string }) => write("azaad.access", a);

export function loadKey(p: ProviderId): string {
  try {
    return localStorage.getItem(`azaad.key.${p}`) ?? "";
  } catch {
    return "";
  }
}
export function saveKey(p: ProviderId, key: string) {
  try {
    if (key) localStorage.setItem(`azaad.key.${p}`, key);
    else localStorage.removeItem(`azaad.key.${p}`);
  } catch {
    /* ignore */
  }
}

export function loadConversations(): Conversation[] {
  try {
    return JSON.parse(localStorage.getItem("azaad.conversations.v2") ?? "[]");
  } catch {
    return [];
  }
}
export function saveConversations(c: Conversation[]) {
  write("azaad.conversations.v2", c.slice(0, 60).map((x) => ({ ...x, turns: x.turns.map((t) => (t.status === "running" ? { ...t, status: "stopped" } : t)) })));
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
