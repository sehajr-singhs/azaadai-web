#!/usr/bin/env python3
"""azaad: Bunga Azaadi's model in your terminal.

    azaad                         interactive session
    azaad "question"              one answer, then exit
    azaad -c "question"           with the Council (the eight-voice swarm)
    azaad login <code>            unlock the research model for your group
    azaad logout | status

Engines (the model is the hardware; azaad owns the session):
    azaad (default)   Bunga Azaadi's fine-tuned model, with its line of research
    ollama            any local Ollama model, fed the same library passages
    claude            Claude Code headless (claude -p), fed the same passages

One file, Python 3.9+, standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

VERSION = "2.0.0"
GATEWAY = os.environ.get("AZAAD_URL", "https://sehajr-singhs--azaad-gateway-web.us-east.modal.run").rstrip("/")
HOME = Path(os.environ.get("AZAAD_HOME", Path.home() / ".azaad"))
CONFIG = HOME / "config.json"

WORD = r"""
 █████╗ ███████╗ █████╗  █████╗ ██████╗
██╔══██╗╚══███╔╝██╔══██╗██╔══██╗██╔══██╗
███████║  ███╔╝ ███████║███████║██║  ██║
██╔══██║ ███╔╝  ██╔══██║██╔══██║██║  ██║
██║  ██║███████╗██║  ██║██║  ██║██████╔╝
╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝"""

HELP = """\
  /council        toggle the Council, beta (eight voices, three passes, one synthesis)
  /research       toggle research mode (needs an access code)
  /trace          toggle the line of research
  /sources        list the sources behind the last answer
  /engine <name>  azaad | ollama | claude
  /model <id>     model for the ollama / claude engines
  /new            start a new conversation
  /help           this list
  /exit           leave"""


# ---------------------------------------------------------------------------
# Terminal styling
# ---------------------------------------------------------------------------

def _enable_vt() -> bool:
    if not sys.stdout.isatty() or os.environ.get("NO_COLOR"):
        return False
    if os.name == "nt":
        try:
            import ctypes

            k = ctypes.windll.kernel32
            k.SetConsoleMode(k.GetStdHandle(-11), 7)
            k.SetConsoleOutputCP(65001)
        except Exception:
            return False
    return True


COLOR = _enable_vt()
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8")
    except Exception:
        pass


def sty(code: str, s: str) -> str:
    return f"\033[{code}m{s}\033[0m" if COLOR else s


bold = lambda s: sty("1", s)  # noqa: E731
dim = lambda s: sty("2", s)  # noqa: E731
blue = lambda s: sty("38;2;64;110;255", s)  # noqa: E731
red = lambda s: sty("31", s)  # noqa: E731


def width() -> int:
    return max(40, min(100, shutil.get_terminal_size((88, 20)).columns - 2))


class Markdown:
    """Streams markdown to the terminal line by line, with light styling."""

    def __init__(self):
        self.buf = ""

    def feed(self, text: str):
        self.buf += text
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            self.emit(line)

    def close(self):
        if self.buf:
            self.emit(self.buf)
        self.buf = ""

    def emit(self, line: str):
        s = line.rstrip()
        h = re.match(r"^#{1,6}\s+(.*)", s)
        if h:
            print("\n" + bold(self.inline(h.group(1))))
            return
        bullet = re.match(r"^(\s*)([-*]|\d+\.)\s+(.*)", s)
        if bullet:
            indent = len(bullet.group(1))
            mark = "•" if bullet.group(2) in "-*" else bullet.group(2)
            body = self.balance(textwrap.wrap(bullet.group(3), width() - indent - 3) or [""])
            print(" " * indent + f"{mark} " + self.inline(body[0]))
            for rest in body[1:]:
                print(" " * (indent + 2) + self.inline(rest))
            return
        if s.startswith(">"):
            for w in textwrap.wrap(s.lstrip("> "), width() - 2) or [""]:
                print(dim("│ ") + self.inline(w))
            return
        if not s:
            print()
            return
        for w in self.balance(textwrap.wrap(s, width()) or [""]):
            print(self.inline(w))

    @staticmethod
    def balance(lines: list[str]) -> list[str]:
        """Keep **bold** spans intact when wrapping splits them across lines."""
        out, carry = [], False
        for line in lines:
            if carry:
                line = "**" + line
            carry = line.count("**") % 2 == 1
            out.append(line + "**" if carry else line)
        return out

    @staticmethod
    def inline(s: str) -> str:
        s = re.sub(r"\*\*(.+?)\*\*", lambda m: bold(m.group(1)), s)
        s = re.sub(r"(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\w)", lambda m: sty("3", m.group(1)), s)
        s = re.sub(r"\[(\d+(?:\s*[,;]\s*\d+)*)\](?!\()", lambda m: blue("[" + m.group(1).replace(" ", "") + "]"), s)
        s = re.sub(r"`([^`]+)`", lambda m: sty("38;5;250", m.group(1)), s)
        return s


# ---------------------------------------------------------------------------
# Config and HTTP
# ---------------------------------------------------------------------------

def load_config() -> dict:
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_config(cfg: dict):
    HOME.mkdir(parents=True, exist_ok=True)
    CONFIG.write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    try:
        os.chmod(CONFIG, 0o600)
    except Exception:
        pass


def request(path: str, body: dict | None = None, code: str = "", stream: bool = False, base: str = GATEWAY, timeout: float = 600):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method="POST" if data else "GET")
    req.add_header("content-type", "application/json")
    req.add_header("user-agent", f"azaad-cli/{VERSION}")
    if code:
        req.add_header("x-azaad-access", code)
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("error", {}).get("message") or str(e)
        except Exception:
            msg = str(e)
        raise RuntimeError(msg) from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"can't reach {base} ({e.reason})") from None
    if stream:
        return resp
    return json.loads(resp.read())


def sse(resp):
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if line.startswith("data:"):
            data = line[5:].strip()
            if data == "[DONE]":
                return
            yield json.loads(data)


# ---------------------------------------------------------------------------
# Rendering a turn
# ---------------------------------------------------------------------------

class Turn:
    def __init__(self, show_trace: bool):
        self.show_trace = show_trace
        self.answer = ""
        self.sources: list[dict] = []
        self.md = Markdown()
        self.in_reason = False
        self.started = False
        self.reason_buf = ""

    def trace(self, t: dict):
        if not self.show_trace or t["step"] in ("answer", "done") or t["title"] == "Reading the question":
            return
        secs = dim(f"{t['ms'] / 1000:4.1f}s")
        print(f"{blue('·')} {bold(t['title'])}  {secs}")
        if t.get("intent"):
            print(dim(f"  {t['intent']}"))
        if t.get("detail"):
            print(dim(f"  {t['detail']}"))
        for s in t.get("searches") or []:
            print("  " + sty("38;5;250", s["query"]))
            for f in s["found"][:3]:
                print(dim(f"    → {f}"))
        for g in t.get("gaps") or []:
            print(dim(f"  gap: {g}"))
        if t["step"] == "read":
            for p in (t.get("passages") or [])[:6]:
                head = f" › {p['heading']}" if p.get("heading") else ""
                print("  " + blue(f"[{p['n']}]") + f" {p['title']}" + dim(head))
                print(dim("      " + textwrap.shorten(p["snippet"], width() - 8)))
            if not t.get("passages") and t.get("documents"):
                print(dim("  " + " · ".join(t["documents"][:6])))
        if t["step"] == "reason":
            self.in_reason = True

    def reasoning(self, text: str):
        if not self.show_trace:
            return
        self.reason_buf += text
        while "\n" in self.reason_buf:
            line, self.reason_buf = self.reason_buf.split("\n", 1)
            self._reason_line(line)

    def _reason_line(self, line: str):
        line = line.strip().lstrip("-* ").strip()
        if not line:
            return
        m = re.match(r"^([A-Z][A-Za-z ]{2,18}):\s*(.*)$", line)
        text = f"{m.group(1)}. {m.group(2)}" if m else line
        for i, w in enumerate(textwrap.wrap(text, width() - 4)):
            print(dim(("  " if i else "  ") + w))

    def token(self, text: str):
        if not self.started:
            if self.reason_buf:
                self._reason_line(self.reason_buf)
                self.reason_buf = ""
            if self.show_trace:
                print()
            self.started = True
        self.answer += text
        self.md.feed(text)

    def finish(self):
        self.md.close()
        cited = {int(n) for m in re.findall(r"\[(\d+(?:\s*[,;]\s*\d+)*)\]", self.answer) for n in re.split(r"[,;]", m)}
        shown = [s for s in self.sources if s["n"] in cited]
        if shown:
            print()
            print(dim(f"Sources · {len(shown)} cited of {len(self.sources)} read"))
            for s in shown:
                head = f" › {s['heading']}" if s.get("heading") else ""
                print(f"  {blue('[' + str(s['n']) + ']')} {s['title']}{dim(head)}")
                print(dim(f"      {s['url']}"))


# ---------------------------------------------------------------------------
# Engines
# ---------------------------------------------------------------------------

def persona() -> str:
    cache = HOME / "persona.md"
    try:
        if not cache.exists() or time.time() - cache.stat().st_mtime > 86400:
            site = "https://sehajr-singhs.github.io/azaadai-web/azaad.md"
            HOME.mkdir(parents=True, exist_ok=True)
            cache.write_text(urllib.request.urlopen(site, timeout=10).read().decode("utf-8"), encoding="utf-8")
        return cache.read_text(encoding="utf-8")
    except Exception:
        return "You are Azaad, the model of Bunga Azaadi. Answer from the library excerpts and cite them inline as [n]."


def run_azaad(messages, council, mode, code, turn: Turn):
    resp = request("/v1/chat/completions", {"model": "azaad", "stream": True, "messages": messages, "council": council, "mode": mode}, code=code, stream=True)
    for ev in sse(resp):
        if ev.get("error"):
            raise RuntimeError(ev["error"].get("message", "error"))
        if ev.get("azaad_trace"):
            turn.trace(ev["azaad_trace"])
        if ev.get("azaad_sources"):
            turn.sources = ev["azaad_sources"]
        delta = ((ev.get("choices") or [{}])[0].get("delta") or {})
        if delta.get("reasoning_content") or delta.get("reasoning"):
            turn.reasoning(delta.get("reasoning_content") or delta.get("reasoning"))
        if delta.get("content"):
            turn.token(delta["content"])


def library(messages, code, research) -> tuple[str, list]:
    users = [m["content"] for m in messages if m["role"] == "user"]
    q = " ".join(users[-2:] + users[-1:])
    res = request(f"/v1/library/search?q={urllib.parse.quote(q)}&k={16 if research else 10}" + ("" if research else "&mode=public"), code=code)
    return res["excerpts"], res["sources"]


def run_ollama(messages, council, code, research, model, turn: Turn):
    excerpts, turn.sources = library(messages, code, research)
    turn.trace({"step": "read", "title": f"Read {len(turn.sources)} passages", "ms": 0, "documents": list(dict.fromkeys(s["title"] for s in turn.sources))})
    system = persona() + ("\n\n" + COUNCIL if council else "") + "\n\n## LIBRARY EXCERPTS\n\n" + excerpts
    base = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
    resp = request("/v1/chat/completions", {"model": model or "gemma4:31b", "stream": True, "messages": [{"role": "system", "content": system}, *messages]}, stream=True, base=base)
    for ev in sse(resp):
        t = ((ev.get("choices") or [{}])[0].get("delta") or {}).get("content")
        if t:
            turn.token(t)


def run_claude(messages, council, code, research, model, turn: Turn):
    exe = shutil.which("claude") or str(Path.home() / ".local" / "bin" / ("claude.exe" if os.name == "nt" else "claude"))
    if not Path(exe).exists():
        raise RuntimeError("Claude Code isn't installed (claude not found on PATH).")
    excerpts, turn.sources = library(messages, code, research)
    turn.trace({"step": "read", "title": f"Read {len(turn.sources)} passages", "ms": 0, "documents": list(dict.fromkeys(s["title"] for s in turn.sources))})
    system = persona() + ("\n\n" + COUNCIL if council else "") + "\n\n## LIBRARY EXCERPTS\n\n" + excerpts
    convo = "\n\n".join(f"{m['role'].upper()}: {m['content']}" for m in messages[:-1])
    prompt = (f"Conversation so far:\n{convo}\n\n" if convo else "") + messages[-1]["content"]
    cmd = [exe, "-p", prompt, "--append-system-prompt", system, "--output-format", "text"]
    if model:
        cmd += ["--model", model]
    out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=600)
    if out.returncode:
        raise RuntimeError((out.stderr or out.stdout).strip()[-500:])
    turn.token(out.stdout.strip() + "\n")


COUNCIL = """## COUNCIL MODE (armed)
Before answering, convene eight voices privately: Bunga Strategist (long-term trajectory; over-reaches), Toshakhana Warden (treasury, risk; over-counts loss), Fauj Guardian (security, legal exposure; sees ambushes), Parchaarak (narrative, history; over-trusts words), Vyapari (markets, enterprise; over-weights profit), Dandani (diplomacy, coalitions; over-accommodates), Gurmukh (Bani, Rehat, inner state; over-weights purity), Lok (the ordinary Sangat; over-weights comfort). Run three passes: Attack, Counter (citing the library), Refine. Print only the synthesis: ## Assessment, ## Where the council agreed, ## Where it split, ## Critical vulnerabilities, ## Strategic pivot, ## Actionable counsel."""


# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------

class Session:
    def __init__(self, args):
        self.cfg = load_config()
        self.council = args.council
        self.engine = args.engine
        self.model = args.model
        self.trace = not args.no_trace
        self.research = bool(self.cfg.get("code")) and not args.public
        self.history: list[dict] = []
        self.last: Turn | None = None

    @property
    def mode_label(self) -> str:
        tier = "research" if self.research else "public"
        bits = [self.engine if self.engine != "azaad" else f"azaad · {tier}"]
        if self.council:
            bits.append("council")
        return " · ".join(bits)

    def ask(self, q: str) -> bool:
        messages = [*self.history[-10:], {"role": "user", "content": q}]
        turn = Turn(self.trace)
        code = self.cfg.get("code", "") if self.research else ""
        t0 = time.time()
        try:
            if self.engine == "azaad":
                run_azaad(messages, self.council, "research" if self.research else "public", code, turn)
            elif self.engine == "ollama":
                run_ollama(messages, self.council, code, self.research, self.model, turn)
            elif self.engine == "claude":
                run_claude(messages, self.council, code, self.research, self.model, turn)
            else:
                raise RuntimeError(f"unknown engine '{self.engine}'")
        except KeyboardInterrupt:
            turn.md.close()
            print(dim("\n[stopped]"))
            return False
        except RuntimeError as e:
            turn.md.close()
            print(red(f"\n{e}"))
            return False
        turn.finish()
        print(dim(f"\n{time.time() - t0:.1f}s · {self.mode_label}"))
        self.history += [{"role": "user", "content": q}, {"role": "assistant", "content": turn.answer}]
        self.last = turn
        return True

    def command(self, line: str) -> bool:
        cmd, _, arg = line.partition(" ")
        arg = arg.strip()
        if cmd in ("/exit", "/quit", "/q"):
            return False
        if cmd == "/help":
            print(HELP)
        elif cmd == "/council":
            self.council = not self.council
            print(dim(f"council (beta) {'on' if self.council else 'off'}"))
        elif cmd == "/research":
            if not self.cfg.get("code"):
                print(dim("research mode needs an access code: azaad login <code>"))
            else:
                self.research = not self.research
                print(dim(f"research {'on' if self.research else 'off'}"))
        elif cmd == "/trace":
            self.trace = not self.trace
            print(dim(f"line of research {'shown' if self.trace else 'hidden'}"))
        elif cmd == "/sources":
            if self.last and self.last.sources:
                for s in self.last.sources:
                    print(f"  {blue('[' + str(s['n']) + ']')} {s['title']}  {dim(s['url'])}")
            else:
                print(dim("no sources yet"))
        elif cmd == "/engine":
            if arg in ("azaad", "ollama", "claude"):
                self.engine = arg
            print(dim(f"engine: {self.engine}"))
        elif cmd == "/model":
            self.model = arg or None
            print(dim(f"model: {self.model or 'default'}"))
        elif cmd == "/new":
            self.history = []
            print(dim("new conversation"))
        else:
            print(dim(f"unknown command {cmd}; /help lists them"))
        return True

    def repl(self):
        print(WORD)
        print(dim("Bunga Azaadi · Institute for Azadist Studies") + "\n")
        group = self.cfg.get("group")
        print(dim(f"{self.mode_label}" + (f" · {group}" if group and self.research else "") + "   /help for commands, Ctrl+C to stop an answer"))
        if self.engine == "azaad":
            try:
                request("/v1/warm", {})
            except Exception:
                pass
        while True:
            try:
                q = input("\n" + bold("ਅ › ") if COLOR else "\n> ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                return
            if not q:
                continue
            if q.startswith("/"):
                if not self.command(q):
                    return
                continue
            print()
            self.ask(q)


def main():
    ap = argparse.ArgumentParser(prog="azaad", description="Bunga Azaadi's model in your terminal.")
    ap.add_argument("question", nargs="*", help="ask once and exit, or: login <code> | logout | status")
    ap.add_argument("-c", "--council", action="store_true", help="convene the eight-voice Council (beta)")
    ap.add_argument("--public", action="store_true", help="use the public model even when logged in")
    ap.add_argument("--engine", default=os.environ.get("AZAAD_ENGINE", "azaad"), choices=["azaad", "ollama", "claude"])
    ap.add_argument("--model", help="model for the ollama or claude engines")
    ap.add_argument("--no-trace", action="store_true", help="hide the line of research")
    ap.add_argument("--version", action="version", version=f"azaad {VERSION}")
    args = ap.parse_args()

    words = args.question
    if words and words[0] == "login":
        if len(words) < 2:
            sys.exit("usage: azaad login <code>")
        try:
            res = request("/v1/access", {"code": words[1]})
        except RuntimeError as e:
            sys.exit(red(str(e)))
        cfg = load_config()
        cfg.update(code=words[1], group=res.get("group", ""))
        save_config(cfg)
        print(f"Research access unlocked for {bold(res.get('group', ''))}. Stored in {CONFIG}.")
        return
    if words and words[0] == "logout":
        cfg = load_config()
        cfg.pop("code", None)
        cfg.pop("group", None)
        save_config(cfg)
        print("Logged out. Back to the public model.")
        return
    if words and words[0] == "status":
        cfg = load_config()
        try:
            st = request("/v1/status")
            gpu = "warm" if st.get("warm") else ("starting" if st.get("starting") else "asleep (first answer takes about a minute)")
        except RuntimeError as e:
            gpu = f"unreachable: {e}"
        print(f"gateway  {GATEWAY}\nmodel    {gpu}\naccess   {cfg.get('group') or 'public'}")
        return

    s = Session(args)
    if words:
        ok = s.ask(" ".join(words))
        sys.exit(0 if ok else 1)
    if not sys.stdin.isatty():
        q = sys.stdin.read().strip()
        if q:
            sys.exit(0 if s.ask(q) else 1)
        return
    s.repl()


if __name__ == "__main__":
    main()
