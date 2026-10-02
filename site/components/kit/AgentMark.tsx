import type { ReactElement } from "react";

/**
 * BrandMark's twin (UI/Console/BrandMarks.swift:3-13, 46-110, 119-164), cut to the three agents the page draws: the vendor's
 * own SVG path data, drawn monochrome in the brand colour, 14 on the fixed 20 icon column; titanium while `quiet` (the session
 * is over). These are the app's own agent marks and ship as inline paths; every other brand on the site stays @thesvg/react.
 * Codex keeps its chip: a rounded rect in --jh-mark-chip with a hairline, the blossom in paper padded 10 %, the `>_` cuts in
 * the chip colour (BrandMarks.swift:20-23, 73-84). Cursor draws in --jh-fg. Server-only in practice (the Console window and
 * the drawings render on the server).
 */
export type AgentTool = "claude" | "codex" | "cursor";

/** Protocol.swift:303-314 */
const AGENT_LABELS: Record<AgentTool, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };

// BrandLogos (BrandMarks.swift:119-164), verbatim. Licences: Claude Code MIT · Codex brand-use · Cursor CC0-1.0.
const CLAUDE =
  "M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z";
const CODEX_BODY =
  "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457z";
const CODEX_CUTS =
  "M7.282 8.307a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zM12.728 14.547a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z";
const CURSOR =
  "M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z";
const TITANIUM = "var(--jh-titanium)";

const LOGOS: Record<Exclude<AgentTool, "codex">, { readonly box: string; readonly path: string; readonly color: string }> = {
  claude: { box: "0 0 24 24", path: CLAUDE, color: "var(--jh-mark-claude)" },
  cursor: { box: "0 0 466.73 532.09", path: CURSOR, color: "var(--jh-fg)" },
};

export function AgentMark({ tool, size = 14, quiet, className }: { readonly tool: AgentTool; readonly size?: 14 | 24; readonly quiet?: boolean; readonly className?: string }): ReactElement {
  const cls = `kit-agent-mark${className ? ` ${className}` : ""}`;
  const label = quiet ? `${AGENT_LABELS[tool]}, over` : AGENT_LABELS[tool];
  const common = { className: cls, width: size, height: size, role: "img", "aria-label": label, preserveAspectRatio: "xMidYMid meet" } as const;
  if (tool === "codex") {
    const r = 24 * 0.22;
    const pad = 24 * 0.1;
    const s = (24 - 2 * pad) / 24;
    return (
      <svg {...common} viewBox="0 0 24 24">
        <rect x="0.5" y="0.5" width="23" height="23" rx={r} fill="var(--jh-mark-chip)" stroke="var(--jh-hair)" />
        <g transform={`translate(${pad} ${pad}) scale(${s})`}>
          <path d={CODEX_BODY} fill={quiet ? TITANIUM : "var(--jh-paper)"} fillRule="evenodd" clipRule="evenodd" />
          <path d={CODEX_CUTS} fill="var(--jh-mark-chip)" stroke="var(--jh-mark-chip)" strokeWidth={24 * 0.05} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      </svg>
    );
  }
  const logo = LOGOS[tool];
  return (
    <svg {...common} viewBox={logo.box}>
      <path d={logo.path} fill={quiet ? TITANIUM : logo.color} fillRule="evenodd" clipRule="evenodd" />
    </svg>
  );
}
