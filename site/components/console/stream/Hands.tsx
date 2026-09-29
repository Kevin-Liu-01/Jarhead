import type { ReactElement } from "react";
import { Row } from "@/components/kit";
import { ThemeImage } from "@/components/ui/Screen";
import { HANDS, SHOTS } from "@/content/deck";
import { HandsRail } from "../railGroups";
import { Frame, Sec, Tone } from "./parts";

/** 04 · Hands: the lead as one lead, the three lines as rows, the Console with a Claude Code session in it at 0.5× (the ledger keeps the hands' figures); its Agents group is the rail's. */
export function Hands(): ReactElement {
  return (
    <Sec id={HANDS.id} name={HANDS.name} n={HANDS.n} phase={HANDS.phase} face={HANDS.face} h2={HANDS.h2} lead={HANDS.lead} rail={<HandsRail />}>
      <ul role="list" className="kit-rows sec-rows">
        <Row size={13} icon={<Tone name="circle" />} title={HANDS.lines[0]} />
        <Row size={13} icon={<Tone name="summon" />} title={HANDS.lines[1]} />
        <Row size={13} icon={<Tone name="terminal" />} title={HANDS.lines[2]} />
      </ul>
      <Frame className="hands-console">
        <ThemeImage dark={SHOTS.consoleDark} light={SHOTS.consoleLight} width={1600} height={1030} />
      </Frame>
    </Sec>
  );
}
