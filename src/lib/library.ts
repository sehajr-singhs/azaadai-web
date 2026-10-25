// The Bunga Azaadi library, loaded live from the Vichaar Repository's public
// Obsidian Publish source (bungaazaadi.com). Nothing is rehosted here: every
// visitor fetches the current text straight from the source, so citations
// always link back to the original page.

import { idbGet, idbSet } from "./idb";

const SITE_UID = "8a12b61764a2b0b075c408ab3423a91e";
const HOST = "https://publish-01.obsidian.md";
const PUBLIC = "https://bungaazaadi.com";
const DYP_PDF = "img/Dharam_Yudh_Pipeline_Whitepaper.pdf";
const CACHE_KEY = "library.v3";
const CACHE_MS = 24 * 3600 * 1000;

export interface Doc {
  path: string;
  title: string;
  section: string; // top-level branch, e.g. "Raajniti Vidya"
  url: string;
  core: boolean;
  chars: number;
}

export interface Chunk {
  id: number;
  doc: number;
  heading: string;
  text: string;
}

export interface Hit {
  chunk: Chunk;
  doc: Doc;
  score: number;
}

export interface Library {
  docs: Doc[];
  chunks: Chunk[];
  loadedAt: number;
}

// The papers people ask about most get a retrieval boost and a "core" badge.
const CORE = [
  /Azadist Manifesto\//,
  /Khalistan Vs Khalsa Raaj/,
  /The Khalsa Is The Guru/,
  /Dharam Yudh Pipeline/,
  /Azadism in 500 Words/,
];

export function publicUrl(path: string): string {
  const p = path.replace(/\.md$/, "").split("/").map((s) => encodeURIComponent(s).replace(/%20/g, "+"));
  return `${PUBLIC}/${p.join("/")}`;
}

// ---------------------------------------------------------------------------
// Cleaning and chunking
// ---------------------------------------------------------------------------

export function cleanMarkdown(md: string): string {
  return md
    .replace(/^---\n[\s\S]*?\n---\n/, "") // front matter
    .replace(/!\[\[[^\]]*\]\]/g, "") // embeds
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2") // [[target|label]]
    .replace(/\[\[([^\]]+)\]\]/g, (_, t: string) => t.split("/").pop()!.replace(/#.*/, ""))
    .replace(/\[([^\]]+)\]\((?:https?:)?[^)]*\)/g, "$1") // keep link text
    .replace(/<[^>]+>/g, "")
    .replace(/^>\s*\[!\w+\][+-]?\s*/gm, "> ") // callouts
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const MAX_CHUNK = 1400;

export function chunkDoc(text: string, title: string): { heading: string; text: string }[] {
  const out: { heading: string; text: string }[] = [];
  let heading = title;
  let buf = "";
  const flush = () => {
    const t = buf.trim();
    if (t.length > 40) out.push({ heading, text: t });
    buf = "";
  };
  for (const para of text.split(/\n\s*\n/)) {
    const h = para.match(/^#{1,4}\s+(.+)/);
    if (h) {
      flush();
      heading = h[1].replace(/[*_`]/g, "").trim();
      const rest = para.slice(h[0].length).trim();
      if (rest) buf = rest;
      continue;
    }
    if (buf.length + para.length > MAX_CHUNK) flush();
    if (para.length > MAX_CHUNK) {
      // Split a giant paragraph on sentence boundaries.
      for (const s of para.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [para]) {
        if (buf.length + s.length > MAX_CHUNK) flush();
        buf += s;
      }
    } else {
      buf += (buf ? "\n\n" : "") + para;
    }
  }
  flush();
  return out;
}

// The DYP whitepaper PDF is typeset with heavy kerning, so text extraction
// splits words ("Dhar am Y udh"). Re-join fragments when the joined form is a
// word the rest of the corpus uses more often than its rarest fragment
// ("offer ed" -> "offered", but "in to" stays "in to").
export function despace(text: string, vocab: Map<string, number>): string {
  const freq = (w: string) => (/^[ai]$/.test(w) ? 1e6 : (vocab.get(w) ?? 0));
  return text
    .split("\n")
    .map((line) => {
      const toks = line.split(/ +/);
      const out: string[] = [];
      for (let i = 0; i < toks.length; ) {
        let merged = false;
        for (let k = Math.min(5, toks.length - i); k >= 2; k--) {
          const parts = toks.slice(i, i + k);
          const joined = parts.join("");
          const core = joined.toLowerCase().replace(/[^a-z']/g, "");
          const f = freq(core);
          if (core.length < 2 || !f) continue;
          const cores = parts.map((p) => p.toLowerCase().replace(/[^a-z']/g, ""));
          if (cores.some((c) => !c)) continue;
          if (Math.min(...cores.map(freq)) < f) {
            out.push(joined);
            i += k;
            merged = true;
            break;
          }
        }
        if (!merged) out.push(toks[i++]);
      }
      return out.join(" ");
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// BM25 search
// ---------------------------------------------------------------------------

const STOP = new Set(
  "a an and are as at be but by for from has have he her his i if in into is it its of on or our she so than that the their them then there these they this to was we were what when which who why will with you your not do does did can could should would about how all any more most also just only over such".split(" "),
);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9਀-੿]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

function stem(t: string): string {
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

export class Index {
  private tf: Map<string, number>[] = [];
  private len: number[] = [];
  private df = new Map<string, number>();
  private avg = 1;

  constructor(private lib: Library) {
    for (const c of lib.chunks) {
      const d = lib.docs[c.doc];
      // Title and heading words count extra: they say what the chunk is about.
      const toks = [...tokenize(c.text), ...tokenize(`${d.title} ${c.heading}`), ...tokenize(`${d.title} ${c.heading}`)];
      const m = new Map<string, number>();
      for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
      for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.tf.push(m);
      this.len.push(toks.length);
    }
    this.avg = this.len.reduce((a, b) => a + b, 0) / Math.max(1, this.len.length);
  }

  search(query: string, k = 8, maxPerDoc = 3): Hit[] {
    const q = [...new Set(tokenize(query))];
    if (!q.length) return [];
    const N = this.tf.length;
    const k1 = 1.4;
    const b = 0.72;
    const scored: [number, number][] = [];
    for (let i = 0; i < N; i++) {
      const m = this.tf[i];
      let s = 0;
      for (const t of q) {
        const f = m.get(t);
        if (!f) continue;
        const df = this.df.get(t)!;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * this.len[i]) / this.avg)));
      }
      if (s > 0) {
        if (this.lib.docs[this.lib.chunks[i].doc].core) s *= 1.15;
        scored.push([s, i]);
      }
    }
    scored.sort((a, b) => b[0] - a[0]);
    const perDoc = new Map<number, number>();
    const hits: Hit[] = [];
    for (const [score, i] of scored) {
      const chunk = this.lib.chunks[i];
      const n = perDoc.get(chunk.doc) ?? 0;
      if (n >= maxPerDoc) continue;
      perDoc.set(chunk.doc, n + 1);
      hits.push({ chunk, doc: this.lib.docs[chunk.doc], score });
      if (hits.length >= k) break;
    }
    return hits;
  }
}

export function formatExcerpts(hits: Hit[], budget: number): string {
  let out = "";
  hits.forEach((h, i) => {
    const block = `[${i + 1}] ${h.doc.title}${h.chunk.heading && h.chunk.heading !== h.doc.title ? ` > ${h.chunk.heading}` : ""}\n${h.chunk.text}\n\n`;
    if (out.length + block.length <= budget || i === 0) out += block.slice(0, budget);
  });
  return out.trim();
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export type Progress = (done: number, total: number, label: string) => void;

async function fetchText(path: string): Promise<string> {
  const r = await fetch(`${HOST}/access/${SITE_UID}/${encodeURI(path)}`);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.text();
}

function titleOf(path: string): string {
  return path.split("/").pop()!.replace(/\.md$/, "").replace(/^\d+\s+/, "");
}

export async function loadLibrary(onProgress: Progress, force = false): Promise<Library> {
  if (!force) {
    const cached = await idbGet<Library>(CACHE_KEY);
    if (cached && Date.now() - cached.loadedAt < CACHE_MS) return cached;
  }
  const idx = await (await fetch(`${HOST}/cache/${SITE_UID}`)).json();
  const paths = Object.keys(idx).filter((p) => p.endsWith(".md"));
  const docs: Doc[] = [];
  const chunks: Chunk[] = [];
  const vocab = new Map<string, number>([["dyp", 50]]);
  let done = 0;
  const texts: (string | null)[] = new Array(paths.length).fill(null);

  // 8 parallel fetches keeps it quick without hammering the source.
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < paths.length) {
        const i = next++;
        try {
          texts[i] = cleanMarkdown(await fetchText(paths[i]));
        } catch {
          texts[i] = null;
        }
        onProgress(++done, paths.length + 1, titleOf(paths[i]));
      }
    }),
  );

  paths.forEach((path, i) => {
    const text = texts[i];
    if (!text || text.length < 120) return; // skip index/stub pages
    for (const w of text.toLowerCase().match(/[a-z']{2,}/g) ?? []) vocab.set(w, (vocab.get(w) ?? 0) + 1);
    const doc: Doc = {
      path,
      title: titleOf(path),
      section: path.split("/")[0],
      url: publicUrl(path),
      core: CORE.some((re) => re.test(path)),
      chars: text.length,
    };
    const d = docs.push(doc) - 1;
    for (const c of chunkDoc(text, doc.title)) chunks.push({ id: chunks.length, doc: d, ...c });
  });

  // The DYP whitepaper only exists as a PDF; extract it with pdf.js.
  try {
    onProgress(done, paths.length + 1, "Dharam Yudh Pipeline whitepaper (PDF)");
    const text = despace(await pdfText(`${HOST}/access/${SITE_UID}/${encodeURI(DYP_PDF)}`), vocab);
    const doc: Doc = {
      path: "Khalsa Revival/Dharam Yudh Pipeline/Dharam Yudh Pipeline Whitepaper.md",
      title: "The Dharam Yudh Pipeline (Whitepaper)",
      section: "Khalsa Revival",
      url: publicUrl("Khalsa Revival/Dharam Yudh Pipeline/Dharam Yudh Pipeline.md"),
      core: true,
      chars: text.length,
    };
    const d = docs.push(doc) - 1;
    for (const c of chunkDoc(text, doc.title)) chunks.push({ id: chunks.length, doc: d, ...c });
  } catch (e) {
    console.warn("DYP whitepaper unavailable", e);
  }
  onProgress(paths.length + 1, paths.length + 1, "Indexed");

  const lib: Library = { docs, chunks, loadedAt: Date.now() };
  await idbSet(CACHE_KEY, lib);
  return lib;
}

async function pdfText(url: string): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const pdf = await pdfjs.getDocument({ url }).promise;
  const pages: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const content = await (await pdf.getPage(p)).getTextContent();
    let line = "";
    const lines: string[] = [];
    for (const it of content.items as { str: string; hasEOL?: boolean }[]) {
      line += it.str;
      if (it.hasEOL) {
        lines.push(line);
        line = "";
      }
    }
    if (line) lines.push(line);
    // Drop running headers and page-number furniture.
    pages.push(lines.filter((l) => !/Whitepaper Published by Bunga Azaadi|^\s*\(\s*\d[\d\s]*\)\s*$/i.test(l)).join("\n"));
  }
  return pages
    .join("\n\n")
    .replace(/([a-z,])\n(?=[a-z])/g, "$1 ")
    .replace(/[ \t]+/g, " ");
}
