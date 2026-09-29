import type { ReactElement } from "react";
import { Row } from "@/components/kit";
import { COSTS } from "@/content/deck";
import { BillRail } from "../railGroups";
import { Sec, Tone } from "./parts";

/** Costs: the three lines as rows; the three figures are the rail's group (railGroups.tsx). */
export function Costs(): ReactElement {
  return (
    <Sec id={COSTS.id} name={COSTS.name} label={COSTS.label} h2={COSTS.h2} lead={COSTS.lead} rail={<BillRail />}>
      <ul role="list" className="kit-rows sec-rows">
        <Row size={13} icon={<Tone name="voice" />} title={COSTS.lines[0]} />
        <Row size={13} icon={<Tone name="folder" />} title={COSTS.lines[1]} />
        <Row size={13} icon={<Tone name="live" />} title={COSTS.lines[2]} />
      </ul>
    </Sec>
  );
}
