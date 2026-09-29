import type { ReactElement } from "react";
import { Row } from "@/components/kit";
import { COSTS, SLEEP } from "@/content/deck";
import { row } from "@/lib/cut";
import { SleepRail } from "../railGroups";
import { Sec, Tone, figureCard } from "./parts";

const ASLEEP = row(COSTS.figures, 2); // $0 · asleep

/** 06 · Sleep: the three lines as rows with the $0 beside the first; the island ringing its alarm is the rail's group (railGroups.tsx). */
export function Sleep(): ReactElement {
  return (
    <Sec id={SLEEP.id} name={SLEEP.name} n={SLEEP.n} phase={SLEEP.phase} face={SLEEP.face} h2={SLEEP.h2} lead={SLEEP.lead} rail={<SleepRail />}>
      <ul role="list" className="kit-rows sec-rows">
        <Row size={13} icon={<Tone name="quit" />} title={SLEEP.lines[0]} value={ASLEEP.value} tip={{ card: figureCard(ASLEEP) }} />
        <Row size={13} icon={<Tone name="checkCircle" tone="acting" />} title={SLEEP.lines[1]} />
        <Row size={13} icon={<Tone name="slashCircle" />} title={SLEEP.lines[2]} />
      </ul>
    </Sec>
  );
}
