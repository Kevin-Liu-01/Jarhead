import type { ReactElement } from "react";
import { Row } from "@/components/kit";
import { RAILS, SHOTS } from "@/content/deck";
import { NeverRail } from "../railGroups";
import { Crop, Pic, Sec, Tone } from "./parts";

/** 05 · Rails (picture right): the three lines as rows; the Claude Code session's Allow · Deny cropped from the capture at 0.5× (x 384 to 1176, y 340 to 1030 at 2×); the never-list is the rail's group (railGroups.tsx). */
export function Rails(): ReactElement {
  return (
    <Sec
      id={RAILS.id}
      name={RAILS.name}
      n={RAILS.n}
      phase={RAILS.phase}
      face={RAILS.face}
      h2={RAILS.h2}
      lead={RAILS.lead}
      side="right"
      rail={<NeverRail />}
      pic={
        <Pic caption={SHOTS.consoleDark.alt}>
          <Crop shot={{ ...SHOTS.consoleDark, width: 1600, height: 1030 }} scale={0.5} x={192} y={170} width={396} height={345} alt="" />
        </Pic>
      }
    >
      <ul role="list" className="kit-rows sec-rows">
        <Row size={13} icon={<Tone name="checkCircle" tone="acting" />} title={RAILS.lines[0]} />
        <Row size={13} icon={<Tone name="handRaised" tone="speaking" />} title={RAILS.lines[1]} />
        <Row size={13} icon={<Tone name="slashCircle" />} title={RAILS.lines[2]} />
      </ul>
    </Sec>
  );
}
