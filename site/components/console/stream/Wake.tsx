import type { ReactElement } from "react";
import { Row } from "@/components/kit";
import { SHOTS, WAKE } from "@/content/deck";
import { WakeRail } from "../railGroups";
import { Frame, Sec, Tone } from "./parts";

/** 01 · Wake: the three lines as rows, then the gate capture alone in its frame; the five faces are the rail's rows (railGroups.tsx). */
export function Wake(): ReactElement {
  return (
    <Sec id={WAKE.id} name={WAKE.name} n={WAKE.n} phase={WAKE.phase} face={WAKE.face} h2={WAKE.h2} grey={false} lead={WAKE.lead} rail={<WakeRail />}>
      <ul role="list" className="kit-rows sec-rows">
        <Row size={13} icon={<Tone name="lock" />} title={WAKE.lines[0]} />
        <Row size={13} icon={<Tone name="slashCircle" />} title={WAKE.lines[1]} />
        <Row size={13} icon={<Tone name="stop" />} title={WAKE.lines[2]} />
      </ul>
      <Frame className="wake-screen">
        <img src={SHOTS.blobGate.src} alt={SHOTS.blobGate.alt} width={260} height={260} decoding="async" loading="lazy" className="wake-gate" />
      </Frame>
    </Sec>
  );
}
