import type { ReactElement } from "react";
import { Hex, IsoBox, Port, Wire, faceLeft, fg, iso, plane } from "./iso";

/*
 * Three 200 × 140 tiles in Mailroom's iso voice (MAILROOM.md §4 "Triptych tiles"), drawn to fill the card's width
 * as Mailroom's do: a Mac whose notch is lit for Wake, a packet leaving the brain for Say, a cursor at a control
 * under the target ring for Hands. No words are drawn inside a tile, so each is aria-hidden.
 */
function Tile({ children }: { readonly children: ReactElement }): ReactElement {
  return (
    <svg className="mr-tile" viewBox="0 0 200 140" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** 01 · Wake: the Mac, its lid up, the island under the notch lit in the listening colour, a word arriving on a wire. */
export function WakeTile(): ReactElement {
  const port = iso(-20, 34, 2);
  return (
    <Tile>
      <g>
        <g transform="translate(110 84)">
          <IsoBox u0={-38} v0={-4} u1={38} v1={34} h={4} tone="dark" shadow />
          <IsoBox u0={-38} v0={-8} u1={38} v1={-4} z={4} h={50} tone="dark">
            <g transform={faceLeft(-35, -4, 52)}>
              <rect width={70} height={46} rx={1.5} style={{ fill: "var(--jh-ground)" }} />
              <rect width={70} height={5} style={{ fill: fg(16, "var(--jh-ground)") }} />
              <rect x={27} y={0} width={16} height={5} style={{ fill: "var(--jh-desk-notch)" }} />
              <rect x={20} y={5} width={30} height={14} rx={3} style={{ fill: "var(--jh-desk-notch)", stroke: "var(--jh-listening)" }} strokeWidth={1} />
              <circle cx={31} cy={12} r={1.7} style={{ fill: "var(--jh-listening)" }} />
              <circle cx={39} cy={12} r={1.7} style={{ fill: "var(--jh-listening)" }} />
            </g>
          </IsoBox>
          <Port at={port} />
        </g>
        <Wire d={`M8 ${110 + port[1] + 1} H${110 + port[0]}`} />
        <Hex at={[24, 76]} />
        <Hex at={[40, 70]} filled />
      </g>
    </Tile>
  );
}

/** 02 · Say: the brain, a box with a slot; the utterance arrives on one wire, the answer leaves on another toward the hands. */
export function SayTile(): ReactElement {
  const inPort = iso(-6, 22, 17);
  const outPort = iso(22, 6, 16);
  const bx = 66;
  const by = 84;
  return (
    <Tile>
      <g>
        <Wire d={`M8 ${by + inPort[1]} H${bx + inPort[0]}`} />
        <Hex at={[22, 62]} />
        <g transform={`translate(${bx} ${by})`}>
          <IsoBox u0={-22} v0={-22} u1={22} v1={22} h={34} tone="dark" shadow>
            <g transform={plane(-12, -3, 34)}>
              <rect width={24} height={6} rx={1} style={{ fill: "var(--jh-ground)" }} />
            </g>
          </IsoBox>
          <Port at={inPort} />
          <Port at={outPort} />
        </g>
        <Wire d={`M${bx + outPort[0]} ${by + outPort[1]} H118 V58 H176`} />
        <Hex at={[130, 44]} />
        <Hex at={[150, 58]} filled />
        <g transform="translate(184 68)">
          <IsoBox u0={-10} v0={-8} u1={10} v1={8} h={3} shadow />
        </g>
      </g>
    </Tile>
  );
}

/** 03 · Hands: a window slab; the cursor sits on a control inside the target ring; a key on a wire at the left. */
export function HandsTile(): ReactElement {
  const anchor = iso(-46, -28, 4);
  const cx = 100 + (73 - 45) * 0.866 + anchor[0];
  const cy = 78 + (73 + 45) * 0.5 + anchor[1];
  return (
    <Tile>
      <g>
        <g transform="translate(100 78)">
          <IsoBox u0={-50} v0={-32} u1={50} v1={32} h={4} shadow>
            <g transform={plane(-46, -28, 4)}>
              <rect width={92} height={56} rx={1.5} style={{ fill: "var(--jh-ground)", stroke: fg(30) }} strokeWidth={1} />
              <rect width={92} height={7} style={{ fill: fg(8, "var(--jh-ground)") }} />
              <circle cx={5} cy={3.5} r={1.4} style={{ fill: fg(30) }} />
              <circle cx={10} cy={3.5} r={1.4} style={{ fill: fg(30) }} />
              <circle cx={15} cy={3.5} r={1.4} style={{ fill: fg(30) }} />
              <rect x={8} y={14} width={44} height={3} rx={1} style={{ fill: fg(22) }} />
              <rect x={8} y={21} width={60} height={3} rx={1} style={{ fill: fg(14) }} />
              <rect x={8} y={28} width={36} height={3} rx={1} style={{ fill: fg(14) }} />
              <rect x={60} y={40} width={26} height={10} rx={2} style={{ fill: "var(--jh-fg)" }} />
            </g>
          </IsoBox>
        </g>
        <g transform="translate(34 110)">
          <IsoBox u0={-7} v0={-7} u1={7} v1={7} h={6} tone="dark" shadow />
          <Port at={iso(0, -7, 3)} s={3} />
        </g>
        <Wire d="M40 103 V78 H52" />
        <circle cx={cx} cy={cy} r={12} style={{ fill: "none", stroke: "var(--jh-acting)" }} strokeWidth={1.5} />
        <circle className="mr-signal" cx={cx} cy={cy} r={12} />
        <circle cx={cx} cy={cy} r={2.2} style={{ fill: "var(--jh-acting)" }} />
        <path transform={`translate(${cx + 8} ${cy + 6})`} d="M0 0 L0 14 L3.6 10.6 L6.2 16 L8.6 14.9 L6 9.6 L10.6 9.6 Z" style={{ fill: "var(--jh-fg)", stroke: "var(--jh-ground)" }} strokeWidth={1} strokeLinejoin="round" />
      </g>
    </Tile>
  );
}
