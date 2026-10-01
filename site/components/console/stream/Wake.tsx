import type { ReactElement } from "react";
import { Row } from "@/components/kit";
import { SHOTS, WAKE } from "@/content/deck";
import { WakeRail } from "../railGroups";
import { Pic, Render, Sec, Tone } from "./parts";

/** 01 · Wake (picture right): the three lines as rows; the gate render at one CSS px per file px (crisp dither), the frame on the blob and its pill, captioned with the deck's alt; the five faces are the rail's rows (railGroups.tsx). */
export function Wake(): ReactElement {
  return (
    <Sec
      id={WAKE.id}
      name={WAKE.name}
      n={WAKE.n}
      h2={WAKE.h2}
      grey={false}
      lead={WAKE.lead}
      side="right"
      rail={<WakeRail />}
      pic={
        <Pic caption={SHOTS.blobGate.alt}>
          <Render shot={SHOTS.blobGate} x={0.5} y={0.6} />
        </Pic>
      }
    >
      <ul role="list" className="kit-rows sec-rows">
        <Row size={13} icon={<Tone name="lock" />} title={WAKE.lines[0]} />
        <Row size={13} icon={<Tone name="slashCircle" />} title={WAKE.lines[1]} />
        <Row size={13} icon={<Tone name="stop" />} title={WAKE.lines[2]} />
      </ul>
    </Sec>
  );
}
