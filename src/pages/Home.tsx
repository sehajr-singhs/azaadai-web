import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { BUNGA, Dome, Footer, Header, Mark, Out } from "../components/brand";
import { Internal } from "../components/Internal";

const BASE = import.meta.env.BASE_URL;
const SITE = `https://sehajr-singhs.github.io${BASE}`;
const REPO = "https://github.com/sehajr-singhs/azaadai-web";

const PAINTINGS = [
  { src: "img/maharaja.jpg", pos: "50% 30%" },
  { src: "img/darbar.jpg", pos: "50% 40%" },
  { src: "img/harmandir.jpg", pos: "50% 45%" },
  { src: "img/workshop.jpg", pos: "50% 40%" },
  { src: "img/bazaar.jpg", pos: "50% 40%" },
];

export const PAPERS = [
  {
    title: "The Azadist Manifesto",
    body: "The world's first Sikhi-based political economy. Incentives, markets, private over nationalised provision, taxation as theft with a Negative Income Tax in the interim, and a State cut to defence, policing and courts that limits itself out of existence.",
    href: `${BUNGA}/Raajniti+Vidya/Azadism/Azadist+Manifesto/Azadist+Manifesto`,
    img: "img/paper-manifesto.jpg",
  },
  {
    title: "Khalistan vs Khalsa Raaj",
    body: "Khalistan is a modern nation-state project, a demand some forty years old. Khalsa Raaj is the older and larger vision the Gurus incubated: a transcendent sovereignty where the Guru is King of Kings and every Khalsa a Shah.",
    href: `${BUNGA}/Raajniti+Vidya/Khalistanism/Khalistan+Vs+Khalsa+Raaj`,
    img: "img/paper-khalistan.jpg",
  },
  {
    title: "The Khalsa Is The Guru",
    body: "Guru Gobind Singh gave Gurgaddi to the Shabad and to the Khalsa Panth. What that means for authority, why Sikhs have no pope, and how the Sarbat Khalsa should decide.",
    href: `${BUNGA}/Khalsa+Revival/Khalsanama/Khalsa+Status/Khalsa+Status`,
    img: "img/paper-khalsa.jpg",
  },
  {
    title: "The Dharam Yudh Pipeline",
    body: "Ingestion, Training & Qualifications, Operations. A lawful pipeline that turns GurSikhs into professionals in security, defence and justice, ready to build modern Misls.",
    href: `${BUNGA}/Khalsa+Revival/Dharam+Yudh+Pipeline/Dharam+Yudh+Pipeline`,
    img: "img/chiefs.jpg",
  },
];

export const VOICES: [string, string, string][] = [
  ["Bunga Strategist", "the long road to Khalsa Raaj, alliances, structural autonomy", "over-reaches on ambition"],
  ["Toshakhana Warden", "treasury, assets, logistics, downside risk", "over-counts loss"],
  ["Fauj Guardian", "security, legal exposure, feasibility, contingencies", "treats every option as an ambush"],
  ["Parchaarak", "narrative, communication, accurate history", "over-trusts words"],
  ["Vyapari", "markets, enterprise, capital, self-reliance", "over-weights profit"],
  ["Dandani", "diplomacy, coalitions, legitimacy", "over-weights accommodation"],
  ["Gurmukh", "Bani, Rehat, Naam, the inner state first", "over-weights purity"],
  ["Lok", "the ordinary Sangat: families, jobs, Gurdwara life", "over-weights short-term comfort"],
];

function Row({ id, icon, label, children, side }: { id?: string; icon?: ReactNode; label: string; children: ReactNode; side?: ReactNode }) {
  return (
    <section id={id} className="grid-row scroll-mt-20 py-14 md:py-20">
      <div className="flex flex-col gap-2">
        {icon}
        <h2 className="label">{label}</h2>
      </div>
      <div className="text-[14.5px] leading-[1.5] text-paper/90 md:text-justify">{children}</div>
      <div className="flex flex-col justify-end gap-1.5 text-[13px] md:items-start">{side}</div>
    </section>
  );
}

function Term({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div>
      <p className="font-semibold italic">{name}</p>
      <p>{children}</p>
    </div>
  );
}

function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(children).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        });
      }}
      className="group flex w-full items-center justify-between gap-3 rounded-[4px] border border-ash-3 bg-ash-1 px-3 py-2.5 text-left font-mono text-[12.5px] text-paper/90 hover:border-ash-4"
      title="Copy"
    >
      <span className="min-w-0 overflow-x-auto whitespace-nowrap">{children}</span>
      <span className="shrink-0 font-sans text-[11px] text-ash-5 group-hover:text-paper">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

export function Home({ route, onAsk, access, onAccess }: {
  route: string;
  onAsk: (q: string) => void;
  access: { code: string; group: string };
  onAccess: (a: { code: string; group: string }) => void;
}) {
  const [slide, setSlide] = useState(0);
  const [q, setQ] = useState("");

  useEffect(() => {
    const t = setInterval(() => setSlide((s) => (s + 1) % PAINTINGS.length), 6500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const id = route.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
    else window.scrollTo({ top: 0 });
  }, [route]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) onAsk(q.trim());
  };

  return (
    <div className="min-h-screen bg-ink">
      <Header route={route} />

      {/* Hero */}
      <div className="relative h-[78svh] min-h-[520px] overflow-hidden">
        {PAINTINGS.map((p, i) => (
          <img
            key={p.src}
            src={`${BASE}${p.src}`}
            alt=""
            loading={i === 0 ? "eager" : "lazy"}
            style={{ objectPosition: p.pos }}
            className={`absolute inset-0 h-full w-full scale-[1.04] object-cover transition-[opacity,transform] duration-[2400ms] ease-out ${i === slide ? "scale-100 opacity-100" : "opacity-0"}`}
          />
        ))}
        <div className="absolute inset-x-0 bottom-0 h-[55%] bg-gradient-to-t from-ink via-ink/80 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 px-3 sm:px-4">
          <h1 className="select-none text-[clamp(84px,17vw,260px)] font-bold leading-[0.8] tracking-tightest">Azaad.</h1>
        </div>
      </div>

      {/* Intro + ask */}
      <section className="grid-row pb-6 pt-10 md:pt-14">
        <div className="flex flex-col gap-2">
          <p className="font-gurmukhi text-[13px] text-paper/70">ਨਮੋ ਸ੍ਰੀ ਗੁਰੂ ਖ਼ਾਲਸਾ</p>
          <p className="label">Bunga Azaadi</p>
        </div>
        <div className="flex flex-col gap-6">
          <p className="text-[19px] font-medium leading-[1.35] tracking-[-0.015em] md:text-[22px]">
            The model of the Institute for Azadist Studies. Trained on the Institute's papers, it reads, reasons, and shows you the line of research behind every answer.
          </p>
          <form onSubmit={submit} className="flex items-end gap-3 border-b border-paper/40 pb-2 focus-within:border-paper">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Ask about Khalsa Raaj, the Manifesto, the Pipeline…"
              className="min-w-0 flex-1 bg-transparent text-[17px] text-paper placeholder:text-paper/40 focus:outline-none"
              aria-label="Ask Azaad"
            />
            <button type="submit" className="shrink-0 text-[13px] font-semibold text-paper/80 hover:text-paper">
              Ask ↵
            </button>
          </form>
        </div>
        <div className="flex flex-col justify-end gap-1.5 text-[13px]">
          <a href="#/ask" className="ln">Open the console</a>
          <a href="#/terminal" className="ln">Use it in your terminal</a>
        </div>
      </section>

      <Row
        id="model"
        icon={<Mark className="h-[18px] w-[40px] text-paper" />}
        label="The Model"
        side={
          <>
            <a href="#/ask" className="ln">Ask Azaad</a>
            <a href="#/terminal" className="ln">API & terminal</a>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p>
            Azaad is Gemma 4, a 31-billion-parameter open model, fine-tuned by Bunga Azaadi on its own work. For training, a teacher model worked through thousands of questions from newcomers, critics and practitioners, reading long stretches of the papers for each one and writing out its reasoning. Azaad learned to reason the way the papers do, not to recite them.
          </p>
          <p>
            Every question runs a line of research. Azaad restates what you are really asking, searches the papers from several angles, reads the passages, reasons through them, and answers with each claim cited to its source. You see every step, and every citation opens the original page.
          </p>
          <p>
            This is the Azadist reading. Azaad does not offer its own interpretations of scripture; it speaks from the Institute's work.
          </p>
        </div>
      </Row>

      <Row
        id="definitions"
        label="Working Definitions"
        side={
          <>
            <Out href={`${BUNGA}/Raajniti+Vidya/Azadism/Azadism+Summary/Azadism+in+500+Words`}>Azadism in 500 words</Out>
            <Out href="https://azadism.co.uk/">azadism.co.uk</Out>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Term name="Sikhi">The Guru-guided pursuit of spiritual (Piri) and political (Miri) liberty (Azaadi).</Term>
          <Term name="Khalsa">
            A sovereign political order composed of spiritualists, oriented toward the pursuit of liberty, justice, and sovereignty, and the contestation of tyranny, oppression, and injustice.
          </Term>
          <Term name="Khalsa Raaj">
            An environment safeguarded by the Khalsa in which those seeking spiritual liberty (Mukti) can do so in peace, free from tyranny and oppression (political liberty).
          </Term>
        </div>
      </Row>

      <Row
        id="papers"
        icon={<Dome className="h-[18px] w-fit text-paper" />}
        label="The Papers"
        side={
          <>
            {PAPERS.map((p) => (
              <Out key={p.title} href={p.href}>
                {p.title}
              </Out>
            ))}
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-paper/70">The public model is trained on these four papers and searches only them.</p>
          {PAPERS.map((p) => (
            <Term key={p.title} name={p.title}>
              {p.body}
            </Term>
          ))}
        </div>
      </Row>
      <div className="grid grid-cols-2 gap-px bg-ink px-4 sm:px-5 md:grid-cols-4">
        {PAPERS.map((p) => (
          <a key={p.title} href={p.href} target="_blank" rel="noreferrer" className="group relative aspect-[16/10] overflow-hidden bg-ash-2">
            <img src={`${BASE}${p.img}`} alt={p.title} loading="lazy" className="h-full w-full object-cover opacity-90 transition duration-700 group-hover:scale-[1.03] group-hover:opacity-100" />
          </a>
        ))}
      </div>

      <Row
        id="swarm"
        icon={<Mark className="h-[18px] w-[40px] text-paper" />}
        label="The Swarm"
        side={<a href="#/ask" className="ln">Ask with the Council on</a>}
      >
        <div className="flex flex-col gap-4">
          <p>
            Turn on <span className="font-semibold">Council</span> and Azaad convenes eight voices before it answers. Each holds a mandate and a known bias. They attack the proposition, answer their critics from the library, and refine it until no critique stands unanswered. You get the synthesis: where they agreed, where they split, the critical vulnerabilities, the strategic pivot and the counsel.
          </p>
          <ul className="flex flex-col gap-2">
            {VOICES.map(([name, mandate, bias]) => (
              <li key={name}>
                <span className="font-semibold italic">{name}</span>
                <span className="text-paper/80">: {mandate}.</span> <span className="text-paper/50">Bias: {bias}.</span>
              </li>
            ))}
          </ul>
          <p className="text-paper/70">Three passes: Attack, Counter, Refine. The debate stays private; only the synthesis is printed.</p>
        </div>
      </Row>

      <Row
        id="terminal"
        icon={<span className="font-mono text-[15px] leading-none">&gt;_</span>}
        label="Terminal"
        side={
          <>
            <Out href={`${SITE}azaad.py`}>Download azaad.py</Out>
            <Out href={`${REPO}/tree/main/cli`}>Source</Out>
            <Out href={`${REPO}#api`}>API reference</Out>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p>Azaad in your terminal, with the same line of research, citations and Council. One file, Python 3.9 or newer, no dependencies.</p>
          <div className="flex flex-col gap-2">
            <p className="text-[12px] font-semibold text-paper/60">Windows (PowerShell)</p>
            <Code>{`irm ${SITE}install.ps1 | iex`}</Code>
            <p className="pt-2 text-[12px] font-semibold text-paper/60">macOS and Linux</p>
            <Code>{`curl -fsSL ${SITE}install.sh | sh`}</Code>
          </div>
          <div className="rounded-[4px] border border-ash-3 bg-ash-1 p-3 font-mono text-[12.5px] leading-[1.7] text-paper/85">
            <p><span className="text-ash-5">$</span> azaad</p>
            <p><span className="text-ash-5">$</span> azaad "what is the difference between Khalistan and Khalsa Raaj?"</p>
            <p><span className="text-ash-5">$</span> azaad --council "should our Gurdwara hire a private security firm?"</p>
            <p><span className="text-ash-5">$</span> azaad login <span className="text-ash-5">&lt;access code&gt;</span></p>
          </div>
        </div>
      </Row>

      <Row id="internal" icon={<Dome className="h-[18px] w-fit text-paper" />} label="Internal" side={<span className="text-paper/50">For Bunga Azaadi groups</span>}>
        <Internal access={access} onAccess={onAccess} />
      </Row>

      <div className="h-10" />
      <Footer />
    </div>
  );
}
