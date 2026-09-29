import Swift from "@thesvg/react/swift";
import Typescript from "@thesvg/react/typescript";
import type { ReactElement } from "react";
import { Row } from "@/components/kit";
import { MADE } from "@/content/deck";
import { sentences } from "@/lib/cut";
import { MadeRail } from "../railGroups";
import { Sec, Tone } from "./parts";

const LEAD = sentences(MADE.lead); // "Jarhead.app is Swift." · "The daemon jarheadd is TypeScript." · "Two Swift helpers act on the Mac."
if (LEAD.length !== 3) throw new Error("the Made lead is not three sentences");

/** Made: the lead's three sentences as rows with their language marks, then the ledger and self-edit lines; the Bayer line and the Dock icon are the rail's group (railGroups.tsx). */
export function Made(): ReactElement {
  return (
    <Sec id={MADE.id} name={MADE.name} label={MADE.label} h2={MADE.h2} rail={<MadeRail />}>
      <ul role="list" className="kit-rows sec-rows">
        <Row size={13} icon={<Swift variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />} title={LEAD[0]} />
        <Row size={13} icon={<Typescript variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />} title={LEAD[1]} />
        <Row size={13} icon={<Swift variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />} title={LEAD[2]} />
        <Row size={13} icon={<Tone name="lock" />} title={MADE.lines[1]} />
        <Row size={13} icon={<Tone name="checkCircle" tone="acting" />} title={MADE.lines[2]} />
      </ul>
    </Sec>
  );
}
