import type { ProviderId } from "./providers";
import type { Hit } from "./library";
import { formatExcerpts } from "./library";
import azaadPrompt from "../../prompts/azaad.md?raw";
import councilPrompt from "../../prompts/council.md?raw";

export interface Source {
  n: number;
  title: string;
  heading: string;
  url: string;
  core: boolean;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  model?: string;
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  updated: number;
}

export interface Settings {
  provider: ProviderId;
  models: Partial<Record<ProviderId, string>>;
  baseUrls: Partial<Record<ProviderId, string>>;
  council: boolean;
  rememberKeys: boolean;
}

const DEFAULTS: Settings = {
  provider: "azaad-cloud",
  models: {},
  baseUrls: {},
  council: false,
  rememberKeys: true,
};

function read<T>(store: Storage | undefined, key: string, fallback: T): T {
  try {
    const v = store?.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(store: Storage | undefined, key: string, value: unknown) {
  try {
    store?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked */
  }
}

const ls = typeof localStorage !== "undefined" ? localStorage : undefined;
const ss = typeof sessionStorage !== "undefined" ? sessionStorage : undefined;

export const loadSettings = (): Settings => ({ ...DEFAULTS, ...read(ls, "azaad.settings", {}) });
export const saveSettings = (s: Settings) => write(ls, "azaad.settings", s);

// Keys live in localStorage when "remember" is on, otherwise only for the tab.
export function loadKeys(): Partial<Record<ProviderId, string>> {
  return { ...read(ls, "azaad.keys", {}), ...read(ss, "azaad.keys", {}) };
}
export function saveKeys(keys: Partial<Record<ProviderId, string>>, remember: boolean) {
  write(remember ? ls : ss, "azaad.keys", keys);
  try {
    (remember ? ss : ls)?.removeItem("azaad.keys");
  } catch {
    /* ignore */
  }
}

export const loadConversations = (): Conversation[] => read(ls, "azaad.conversations", []);
export const saveConversations = (c: Conversation[]) => write(ls, "azaad.conversations", c.slice(0, 100));

export const newId = () => Math.random().toString(36).slice(2, 10);

export function buildSystem(hits: Hit[], budget: number, council: boolean): string {
  const excerpts = hits.length ? formatExcerpts(hits, budget) : "(No library excerpts matched this question.)";
  return `${azaadPrompt}\n\n${council ? councilPrompt + "\n\n" : ""}## LIBRARY EXCERPTS\n\n${excerpts}`;
}

export function sourcesFrom(hits: Hit[]): Source[] {
  return hits.map((h, i) => ({
    n: i + 1,
    title: h.doc.title,
    heading: h.chunk.heading !== h.doc.title ? h.chunk.heading : "",
    url: h.doc.url,
    core: h.doc.core,
  }));
}
