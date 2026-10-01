import type { ReactElement } from "react";
import { Row } from "@/components/kit";
import { SAY, SHOTS } from "@/content/deck";
import { SayRail } from "../railGroups";
import { Cut, Pic, Sec, Tone } from "./parts";

/** 02 · Say (picture left): the three lines as bare rows (the 3 ms is Numbers' lead figure, the 71 the Hands lead's and the rail's, so neither is said again here); the Settings tab's Brain card at 1× (the rail at x 1200 to 1600, the card from y 408 at 2×, the row under the Audio group's toggle, down to the Effort row; the Status row's Check button starts 3 px before the frame can end) in the frame; the six brains as marks in the rail. */
export function Say(): ReactElement {
  return (
    <Sec
      id={SAY.id}
      name={SAY.name}
      n={SAY.n}
      h2={SAY.h2}
      lead={SAY.lead}
      side="left"
      rail={<SayRail />}
      pic={
        <Pic caption={SHOTS.consoleSettings.alt}>
          <Cut shot={SHOTS.consoleSettings} scale={1} right={1600} y={408} />
        </Pic>
      }
    >
      <ul role="list" className="kit-rows sec-rows">
        <Row size={13} icon={<Tone name="live" tone="listening" />} title={SAY.lines[0]} />
        <Row size={13} icon={<Tone name="ask" />} title={SAY.lines[1]} />
        <Row size={13} icon={<Tone name="folder" />} title={SAY.lines[2]} />
      </ul>
    </Sec>
  );
}
