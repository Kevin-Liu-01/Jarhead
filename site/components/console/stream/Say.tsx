import type { ReactElement } from "react";
import { Row } from "@/components/kit";
import { HERO, NUMBERS, SAY, SHOTS } from "@/content/deck";
import { part } from "@/lib/cut";
import { SayRail } from "../railGroups";
import { Frame, Sec, Tone, figureCard } from "./parts";

const TOOLS = part(HERO.figures, "71 tools");

/** 02 · Say: the reflex row with its 3 ms, the policy row with its 71, the local row with its badge; the Brain settings cropped from the app; the six brains as marks in the rail. */
export function Say(): ReactElement {
  return (
    <Sec id={SAY.id} name={SAY.name} n={SAY.n} phase={SAY.phase} face={SAY.face} h2={SAY.h2} lead={SAY.lead} rail={<SayRail />}>
      <ul role="list" className="kit-rows sec-rows">
        <Row size={13} icon={<Tone name="live" tone="listening" />} title={SAY.lines[0]} value={NUMBERS.display.value} tip={{ card: figureCard(NUMBERS.display) }} />
        <Row size={13} icon={<Tone name="ask" />} title={SAY.lines[1]} value={TOOLS} />
        <Row size={13} icon={<Tone name="folder" />} title={SAY.lines[2]} badge={{ word: "this Mac" }} />
      </ul>
      <Frame className="say-crop">
        <img src={SHOTS.consoleSettings.src} alt={SHOTS.consoleSettings.alt} width={800} height={610} decoding="async" loading="lazy" />
      </Frame>
    </Sec>
  );
}
