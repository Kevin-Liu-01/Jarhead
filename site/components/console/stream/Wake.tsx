import type { ReactElement } from "react";
import { Row } from "@/components/kit";
import { SHOTS, WAKE } from "@/content/deck";
import { WakeRail } from "../railGroups";
import { Pic, Sec, Tone } from "./parts";

/** 01 · Wake (picture right): the three lines as rows; the gate capture at 0.5× on its own screen ground, its caption the deck's alt; the five faces are the rail's rows (railGroups.tsx). */
export function Wake(): ReactElement {
  return (
    <Sec
      id={WAKE.id}
      name={WAKE.name}
      n={WAKE.n}
      phase={WAKE.phase}
      face={WAKE.face}
      h2={WAKE.h2}
      grey={false}
      lead={WAKE.lead}
      side="right"
      rail={<WakeRail />}
      pic={
        <Pic caption={SHOTS.blobGate.alt} className="pic-gate">
          <img src={SHOTS.blobGate.src} alt="" width={SHOTS.blobGate.width} height={SHOTS.blobGate.height} decoding="async" loading="lazy" className="wake-gate" />
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
