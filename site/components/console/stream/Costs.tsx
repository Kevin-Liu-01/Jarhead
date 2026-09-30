import type { ReactElement } from "react";
import { Row } from "@/components/kit";
import { COSTS, SHOTS } from "@/content/deck";
import { BillRail } from "../railGroups";
import { Crop, Pic, Sec, Tone } from "./parts";

/** Costs (picture left): the three lines as rows; the capsule with its meter cropped from the capture at 0.5× (x 240 to 1032, y 120 to 580 at 2×); the three figures are the rail's group (railGroups.tsx). */
export function Costs(): ReactElement {
  return (
    <Sec
      id={COSTS.id}
      name={COSTS.name}
      label={COSTS.label}
      h2={COSTS.h2}
      lead={COSTS.lead}
      side="left"
      rail={<BillRail />}
      pic={
        <Pic caption={SHOTS.blobCapsule.alt}>
          <Crop shot={SHOTS.blobCapsule} scale={0.5} x={120} y={60} width={396} height={230} alt="" />
        </Pic>
      }
    >
      <ul role="list" className="kit-rows sec-rows">
        <Row size={13} icon={<Tone name="voice" />} title={COSTS.lines[0]} />
        <Row size={13} icon={<Tone name="folder" />} title={COSTS.lines[1]} />
        <Row size={13} icon={<Tone name="live" />} title={COSTS.lines[2]} />
      </ul>
    </Sec>
  );
}
