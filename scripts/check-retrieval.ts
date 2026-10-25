// Offline check of cleaning, chunking, de-spacing and BM25 on a local corpus copy.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { chunkDoc, cleanMarkdown, despace, Index, publicUrl, type Library } from "../src/lib/library";

const root = process.argv[2];
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const lib: Library = { docs: [], chunks: [], loadedAt: 0 };
const vocab = new Map<string, number>([["dyp", 50]]);
for (const f of walk(root).filter((f) => f.endsWith(".md"))) {
  const path = relative(root, f).split("\\").join("/");
  const text = cleanMarkdown(readFileSync(f, "utf8"));
  if (text.length < 120) continue;
  for (const w of text.toLowerCase().match(/[a-z']{2,}/g) ?? []) vocab.set(w, (vocab.get(w) ?? 0) + 1);
  const title = path.split("/").pop()!.replace(/\.md$/, "").replace(/^\d+\s+/, "");
  const d = lib.docs.push({ path, title, section: path.split("/")[0], url: publicUrl(path), core: /Manifesto\/|Khalistan Vs|Khalsa Is The Guru|Dharam Yudh/.test(path), chars: text.length }) - 1;
  for (const c of chunkDoc(text, title)) lib.chunks.push({ id: lib.chunks.length, doc: d, ...c });
}
const dyp = despace(readFileSync(process.argv[3], "utf8"), vocab);
console.log("DESPACED:", dyp.slice(1500, 2100).replace(/\n/g, " "));
const d = lib.docs.push({ path: "dyp", title: "The Dharam Yudh Pipeline (Whitepaper)", section: "Khalsa Revival", url: "", core: true, chars: dyp.length }) - 1;
for (const c of chunkDoc(dyp, "DYP")) lib.chunks.push({ id: lib.chunks.length, doc: d, ...c });
console.log(`\n${lib.docs.length} docs, ${lib.chunks.length} chunks`);
const idx = new Index(lib);
for (const q of ["difference between Khalistan and Khalsa Raaj", "why is the Khalsa the Guru", "three stages of the Dharam Yudh Pipeline", "taxes welfare safety nets", "sarbat khalsa"]) {
  console.log(`\nQ: ${q}`);
  for (const h of idx.search(q, 5)) console.log(`  ${h.score.toFixed(1)}  ${h.doc.title} > ${h.chunk.heading}`);
}
console.log("\nURL check:", lib.docs.find((x) => x.title === "Khalistan Vs Khalsa Raaj")?.url);
