// shadcn/ui-style primitives, written out by hand so the site stays a single
// small bundle with no Radix dependency.

import { forwardRef, useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { ChevronDown, X } from "lucide-react";

export const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

type Variant = "default" | "outline" | "ghost" | "secondary" | "link";
type Size = "default" | "sm" | "icon" | "lg";

const VARIANTS: Record<Variant, string> = {
  default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
  outline: "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
  ghost: "hover:bg-accent hover:text-accent-foreground",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  link: "text-link underline-offset-4 hover:underline",
};
const SIZES: Record<Size, string> = {
  default: "h-9 px-4 py-2",
  sm: "h-8 rounded-md px-3 text-xs",
  lg: "h-10 rounded-md px-6",
  icon: "h-9 w-9",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }>(
  ({ className, variant = "default", size = "default", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  ),
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
      className,
    )}
    {...props}
  />
));

export function Badge({ children, className, tone = "muted" }: { children: ReactNode; className?: string; tone?: "muted" | "gold" | "link" | "outline" }) {
  const tones = {
    muted: "bg-secondary text-secondary-foreground border-transparent",
    gold: "border-gold/30 bg-gold/10 text-gold",
    link: "border-link/30 bg-link/5 text-link",
    outline: "border-border text-muted-foreground",
  };
  return <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[0.7rem] font-medium", tones[tone], className)}>{children}</span>;
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        checked ? "bg-primary" : "bg-input",
      )}
    >
      <span className={cn("pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform", checked ? "translate-x-4" : "translate-x-0")} />
    </button>
  );
}

export function Select({ value, onChange, children, className, ...rest }: { value: string; onChange: (v: string) => void; children: ReactNode; className?: string; "aria-label"?: string }) {
  return (
    <div className={cn("relative", className)}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full appearance-none truncate rounded-md border border-input bg-background py-1 pl-3 pr-8 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        {...rest}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 opacity-50" />
    </div>
  );
}

export function Dialog({ open, onClose, title, description, children, wide }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-in fade-in" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cn("relative z-10 flex max-h-[88vh] w-full flex-col rounded-t-xl border bg-background shadow-xl sm:rounded-xl", wide ? "sm:max-w-3xl" : "sm:max-w-lg")}
      >
        <div className="flex items-start justify-between gap-4 border-b p-5">
          <div>
            <h2 className="text-base font-semibold tracking-tight">{title}</h2>
            {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
          </div>
          <Button variant="ghost" size="icon" className="-mr-2 -mt-1 h-8 w-8" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        </div>
        <div className="scroll-thin overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <span className="text-sm font-medium">{children}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}
