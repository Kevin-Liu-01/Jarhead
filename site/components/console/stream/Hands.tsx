import type { ReactElement } from "react";
import { Row } from "@/components/kit";
import { HANDS, SHOTS } from "@/content/deck";
import { HandsRail } from "../railGroups";
import { Cover, Pic, Sec, Tone } from "./parts";

/** 04 · Hands (picture left): the three lines as rows; the blob beside its target ring fills the frame; the Agents group is the rail's. */
export function Hands(): ReactElement {
  return (
    <Sec
      id={HANDS.id}
      name={HANDS.name}
      n={HANDS.n}
      h2={HANDS.h2}
      lead={HANDS.lead}
      side="left"
      rail={<HandsRail />}
      pic={
        <Pic caption={SHOTS.blobFly.alt}>
          <Cover shot={SHOTS.blobFly} position="50% 47%" />
        </Pic>
      }
    >
      <ul role="list" className="kit-rows sec-rows">
        <Row size={13} icon={<Tone name="circle" />} title={HANDS.lines[0]} />
        <Row size={13} icon={<Tone name="summon" />} title={HANDS.lines[1]} />
        <Row size={13} icon={<Tone name="terminal" />} title={HANDS.lines[2]} />
      </ul>
    </Sec>
  );
}
