import Swift from "@thesvg/react/swift";
import Typescript from "@thesvg/react/typescript";
import type { ReactElement } from "react";
import { Row } from "@/components/kit";
import { MADE, SHOTS } from "@/content/deck";
import { sentences } from "@/lib/cut";
import { MadeRail } from "../railGroups";
import { Pic, Render, Sec, Tone } from "./parts";

const LEAD = sentences(MADE.lead); // "Jarhead.app is Swift." · "The daemon jarheadd is TypeScript." · "Two Swift helpers act on the Mac."
if (LEAD.length !== 3) throw new Error("the Made lead is not three sentences");

/** Made (picture right): the lead's three sentences as rows with their language marks, then the ledger and self-edit lines; the Dock icon sheet at 1×, the frame on the 128 and the 256, whole, 11 px of the sheet's ground either side (the caption names the sheet's five sizes; the row of five is 567 px wide, so no 1× window holds it, and cover at 0.62× blurs the 1× sheet's dither and bleeds the 2× row, so two at 1× stay); the Bayer line and the overlay's shapes are the rail's group (railGroups.tsx). */
export function Made(): ReactElement {
  return (
    <Sec
      id={MADE.id}
      name={MADE.name}
      label={MADE.label}
      h2={MADE.h2}
      side="right"
      rail={<MadeRail />}
      pic={
        <Pic caption={SHOTS.iconSizes.alt}>
          <Render shot={SHOTS.iconSizes} x={0.86} y={0.03} />
        </Pic>
      }
    >
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
