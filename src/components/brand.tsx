import type { ReactNode } from "react";

export const BUNGA = "https://bungaazaadi.com";

const DOME_D =
  "M6.0 418.0C4.0 416.0 4.0 415.3 4.2 299.2L4.5 182.5L6.7 176.4C14.5 155.1 26.7 136.7 45.6 117.6C64.3 98.8 83.0 85.5 107.5 73.4C132.9 61.0 150.2 55.9 184.0 51.0C248.9 41.5 295.5 27.5 322.0 9.5C330.1 4.0 332.3 3.1 333.5 5.0C333.9 5.6 337.6 8.3 341.7 11.2C367.8 28.8 413.1 42.0 478.5 51.0C511.5 55.6 532.0 61.8 558.2 75.2C590.6 91.6 621.2 118.0 639.7 145.5C644.7 152.9 651.4 166.2 654.9 175.5L657.5 182.5L657.8 299.2C658.0 415.3 658.0 416.0 656.0 418.0C654.0 420.0 653.9 420.0 331.0 420.0C8.1 420.0 8.0 420.0 6.0 418.0ZM242.7 336.9C280.7 331.7 313.8 303.2 324.2 266.5C327.3 255.6 327.5 230.0 324.5 220.0C319.0 201.1 306.0 180.0 295.6 172.8L292.5 170.7L295.1 173.6C306.2 186.0 313.6 204.2 314.7 221.7C317.3 262.6 288.0 299.7 245.9 308.5C242.0 309.3 233.7 310.0 227.2 310.0C203.1 310.0 182.7 301.8 165.7 285.2C148.7 268.6 140.7 249.8 140.7 226.5C140.8 207.3 146.5 190.6 158.1 176.0L163.3 169.5L156.1 176.5C144.0 188.2 135.4 203.1 130.9 220.1C127.6 232.2 127.6 253.0 130.8 264.9C135.5 282.3 144.0 296.8 156.7 309.1C179.7 331.5 210.2 341.4 242.7 336.9ZM451.6 336.9C491.3 331.4 524.0 302.9 534.2 264.9C536.0 257.9 536.4 254.0 536.4 242.0C536.3 224.6 534.5 216.6 527.1 201.5C514.4 175.7 492.2 158.0 462.2 149.8C455.8 148.0 451.6 147.7 437.5 147.6C421.9 147.5 419.7 147.7 410.5 150.3C373.9 160.5 346.6 188.8 339.5 223.9C336.9 236.7 337.8 257.6 341.5 269.0C350.0 295.2 367.0 314.9 391.5 327.0C410.7 336.5 430.9 339.8 451.6 336.9Z";

/** The Bunga Azaadi dome. */
export function Dome({ className = "h-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 662 424" className={className} aria-hidden="true">
      <path fillRule="evenodd" fill="currentColor" d={DOME_D} />
    </svg>
  );
}

/** The two-circle mark used as a section glyph on azadism.co.uk. */
export function Mark({ className = "h-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 44 20" className={className} aria-hidden="true">
      <path d="M2 4a8 8 0 0 0 16 0" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="34" cy="10" r="8.5" fill="currentColor" />
    </svg>
  );
}

export function Arrow({ className = "h-[9px] w-[9px]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 10 10" className={className} aria-hidden="true">
      <path d="M1 9 9 1M3 1h6v6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Out({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={`ln ${className}`}>
      {children}
      <Arrow />
    </a>
  );
}

export function Header({ route, solid = false }: { route: string; solid?: boolean }) {
  const nav: [string, string][] = [
    ["#/ask", "Ask"],
    ["#/papers", "Papers"],
    ["#/swarm", "Swarm"],
    ["#/terminal", "Terminal"],
    ["#/internal", "Internal"],
  ];
  return (
    <header className={`fixed inset-x-0 top-0 z-30 ${solid ? "border-b border-ash-3 bg-ink" : "bg-gradient-to-b from-ink/70 to-transparent"}`}>
      <div className="flex h-14 items-center justify-between px-4 sm:px-5">
        <a href="#/" className="flex items-center gap-2.5" aria-label="Azaad home">
          <Dome className="h-[22px] text-paper" />
          <span className="text-[15px] font-semibold tracking-[-0.02em]">Azaad</span>
        </a>
        <nav className="flex items-center gap-4 text-[13px] font-medium sm:gap-6">
          {nav.map(([href, label]) => (
            <a
              key={href}
              href={href}
              className={`${label !== "Ask" ? "hidden sm:inline" : ""} ${route === href.slice(1) ? "text-paper" : "text-paper/70 hover:text-paper"}`}
            >
              {label}
            </a>
          ))}
        </nav>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="bg-blue text-paper">
      <div className="grid grid-cols-2 gap-8 px-4 py-10 sm:px-5 md:grid-cols-[1fr_auto_auto_auto] md:gap-16">
        <div className="col-span-2 flex flex-col gap-3 md:col-span-1">
          <Dome className="h-7 w-fit" />
          <p className="text-[13px] font-medium">© Bunga Azaadi {new Date().getFullYear()}</p>
          <p className="max-w-xs text-[13px] text-paper/75">The Institute for Azadist Studies. A Sikh think tank.</p>
        </div>
        <div className="flex flex-col gap-1.5 text-[13px]">
          <p className="mb-1 font-semibold">Follow Us</p>
          <Out href="https://www.instagram.com/bunga_azaadi/">Instagram</Out>
          <Out href="https://azadism.substack.com/">Substack</Out>
          <Out href="https://www.youtube.com/@azadism">YouTube</Out>
        </div>
        <div className="flex flex-col gap-1.5 text-[13px]">
          <p className="mb-1 font-semibold">Support Us</p>
          <Out href={`${BUNGA}/Support`}>Donate</Out>
          <Out href="https://shop.bungaazaadi.com/">Shop</Out>
          <Out href={BUNGA}>Vichaar Repository</Out>
        </div>
        <div className="flex flex-col gap-1.5 text-[13px]">
          <p className="mb-1 font-semibold">Contact Us</p>
          <a className="ln" href="mailto:contact@azadism.co.uk">
            contact@azadism.co.uk
          </a>
          <Out href="https://azadism.co.uk/">azadism.co.uk</Out>
        </div>
      </div>
      <p className="px-4 pb-6 text-[12px] text-paper/70 sm:px-5">Developed by Sehaj Randhir Singh in tandem with Ranjit Singh.</p>
    </footer>
  );
}
