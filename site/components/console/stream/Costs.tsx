import type { ReactElement } from "react";
import { Row } from "@/components/kit";
import { COSTS, SHOTS } from "@/content/deck";
import { BillRail } from "../railGroups";
import { Cut, Pic, Sec, Tone } from "./parts";

/** Costs (picture left): the three lines as rows; the capsule with the blob beside it at 0.5× (blob-capsule.png from x 74, y 18 at the render's CSS px: the blob whole, the card whole with its phase word, the meter's 7.2 min · $0.36, the exchange, the running step, the transport); the pair is 418 wide, so the frame scales this one window to its 397 (Pic `win`, 0.95) rather than cut the blob; the three figures are the rail's group (railGroups.tsx). */
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
        <Pic caption={SHOTS.blobCapsule.alt} win={418}>
          <Cut shot={SHOTS.blobCapsule} scale={0.5} x={74} y={18} />
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
