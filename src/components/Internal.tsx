import { useState, type FormEvent } from "react";
import { unlock } from "../lib/api";

export function Internal({ access, onAccess, compact = false }: {
  access: { code: string; group: string };
  onAccess: (a: { code: string; group: string }) => void;
  compact?: boolean;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setErr("");
    try {
      const { group } = await unlock(code.trim());
      onAccess({ code: code.trim(), group });
      setCode("");
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {!compact && (
        <p>
          With an access code, Azaad switches to its research model. It is trained on the whole Vichaar Repository, not just the four papers, and it searches all of it. Before answering it checks its own coverage for gaps, searches again, and writes at greater length.
        </p>
      )}
      {access.group ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[4px] border border-paper/20 px-3 py-2.5">
          <p className="text-[13.5px]">
            <span className="font-semibold">Research access</span>
            <span className="text-paper/60"> · {access.group}</span>
          </p>
          <div className="flex items-center gap-4 text-[13px]">
            {!compact && <a href="#/ask" className="ln">Open the console</a>}
            <button type="button" onClick={() => onAccess({ code: "", group: "" })} className="text-paper/60 hover:text-paper">
              Lock
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <div className="flex items-end gap-3 border-b border-paper/40 pb-2 focus-within:border-paper">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Access code"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent font-mono text-[15px] tracking-wider text-paper placeholder:font-sans placeholder:tracking-normal placeholder:text-paper/40 focus:outline-none"
              aria-label="Access code"
            />
            <button type="submit" disabled={busy} className="shrink-0 text-[13px] font-semibold text-paper/80 hover:text-paper disabled:opacity-50">
              {busy ? "Checking…" : "Unlock"}
            </button>
          </div>
          {err && <p className="text-[13px] text-[#ff6b6b]">{err}</p>}
        </form>
      )}
    </div>
  );
}
