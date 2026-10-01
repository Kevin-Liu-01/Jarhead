import type { ReactElement } from "react";
import { Row } from "@/components/kit";
import { COSTS, SHOTS, SLEEP } from "@/content/deck";
import { row } from "@/lib/cut";
import { SleepRail } from "../railGroups";
import { Pic, Sec, Tone, figureCard } from "./parts";
import { Strip } from "./Strip";

const ASLEEP = row(COSTS.figures, 2); // $0 · asleep

/** 06 · Sleep (picture left): the three lines as rows with the $0 beside the first; the island ringing its alarm (notch-island-alarm.png) under the drawn Mac top edge, filling the frame; the Console's Automations group is the rail's (railGroups.tsx). */
export function Sleep(): ReactElement {
  return (
    <Sec
      id={SLEEP.id}
      name={SLEEP.name}
      n={SLEEP.n}
      h2={SLEEP.h2}
      lead={SLEEP.lead}
      side="left"
      rail={<SleepRail />}
      pic={
        <Pic caption={SHOTS.islandAlarm.alt} strip>
          <Strip shot={SHOTS.islandAlarm} />
        </Pic>
      }
    >
      <ul role="list" className="kit-rows sec-rows">
        <Row size={13} icon={<Tone name="quit" />} title={SLEEP.lines[0]} value={ASLEEP.value} tip={{ card: figureCard(ASLEEP) }} />
        <Row size={13} icon={<Tone name="checkCircle" tone="acting" />} title={SLEEP.lines[1]} />
        <Row size={13} icon={<Tone name="slashCircle" />} title={SLEEP.lines[2]} />
      </ul>
    </Sec>
  );
}
