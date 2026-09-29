import type { ReactElement } from "react";
import { Row } from "@/components/kit";
import { RAILS } from "@/content/deck";
import { NeverRail } from "../railGroups";
import { Sec, Tone } from "./parts";

/** 05 · Rails: the three lines as rows; the never-list is the rail's group (railGroups.tsx). */
export function Rails(): ReactElement {
  return (
    <Sec id={RAILS.id} name={RAILS.name} n={RAILS.n} phase={RAILS.phase} face={RAILS.face} h2={RAILS.h2} lead={RAILS.lead} rail={<NeverRail />}>
      <ul role="list" className="kit-rows sec-rows">
        <Row size={13} icon={<Tone name="checkCircle" tone="acting" />} title={RAILS.lines[0]} />
        <Row size={13} icon={<Tone name="handRaised" tone="speaking" />} title={RAILS.lines[1]} />
        <Row size={13} icon={<Tone name="slashCircle" />} title={RAILS.lines[2]} />
      </ul>
    </Sec>
  );
}
