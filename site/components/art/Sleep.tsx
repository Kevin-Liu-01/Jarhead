import type { ReactElement } from "react";
import { ICON_PATHS } from "@/components/desk/Icons";
import { ISLAND } from "@/content/island";
import { after, part } from "@/lib/cut";
import { Art, Disc, El, FG, G, Hole, Label, MARGIN, Orb, Plate, QUIET, RAISED, TICK, Value, W, kit } from "./parts";

/**
 * Sleep (ART-STYLE §8), the asleep accent. Four elements. Across the top, the blob asleep at the left edge (the real orb at
 * 96, quiet, faceless) and the clock that still rings at the right, a disc r 58 with its hands at 07:10 and the crescent in a
 * hole at its foot. Under them, what is still armed while it sleeps, in the island's own words: the alarm (`07:10 · Wake up,
 * Kevin`, `weekdays`, `Monday · standup notes at 9`, on the alarm's dot) and the timer from the asleep line (`Timer 11:56 ·
 * pasta`, on the hourglass). No notch stratum: the page's own island hangs above, asleep and then ringing.
 */
const K = kit("sleep", "--jh-asleep");
const ALARM = ISLAND.hero.alarm; // 07:10 · Wake up, Kevin
const TIMER = after(ISLAND.footAsleep, "next "); // Timer 11:56 · pasta
const WEEKDAYS = part(ISLAND.headAlarm, "weekdays");
/** What it shows, for a screen reader: the two things still armed. */
const SAYS = `${ALARM} · ${TIMER}`;

const TOP_Y = 78;
const ORB = { cx: MARGIN + 52, cy: TOP_Y, size: 96 } as const;
const CLOCK = { cx: W - MARGIN - 4 - 58, cy: TOP_Y, r: 58 } as const;
/** The two armed rows, full width: the alarm 72 tall with its second line, the timer 46. */
const ROWS = { x: MARGIN, w: W - 2 * MARGIN - 4, alarm: { y: 156, h: 72 }, timer: { y: 240, h: 46 } } as const;
/** 07:10: the hour hand at 215°, the minute hand at 60°, clockwise from twelve. */
const HOUR = { deg: 215, len: 30 } as const;
const MIN = { deg: 60, len: 42 } as const;

const at = (deg: number, len: number): readonly [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [CLOCK.cx + len * Math.sin(a), CLOCK.cy - len * Math.cos(a)];
};

export function ArtSleep(): ReactElement {
  const [hx, hy] = at(HOUR.deg, HOUR.len);
  const [mx, my] = at(MIN.deg, MIN.len);
  const moon = { cx: CLOCK.cx - 44, cy: CLOCK.cy + 40 };
  const a = ROWS.alarm;
  const t = ROWS.timer;
  return (
    <Art k={K} label={SAYS}>
      <El name="blob">
        <Orb cx={ORB.cx} cy={ORB.cy} size={ORB.size} quiet />
      </El>

      {/* the clock that still rings at 07:10, the crescent at its foot */}
      <El name="clock">
        <Disc k={K} cx={CLOCK.cx} cy={CLOCK.cy} r={CLOCK.r} band={2}>
          {[0, 90, 180, 270].map((d) => {
            const [x0, y0] = at(d, CLOCK.r - 14);
            const [x1, y1] = at(d, CLOCK.r - 6);
            return <line key={d} x1={x0} y1={y0} x2={x1} y2={y1} stroke={FG} strokeWidth={TICK} strokeLinecap="round" />;
          })}
          <line x1={CLOCK.cx} y1={CLOCK.cy} x2={hx} y2={hy} stroke={FG} strokeWidth={TICK + 1} strokeLinecap="round" />
          <line x1={CLOCK.cx} y1={CLOCK.cy} x2={mx} y2={my} stroke={FG} strokeWidth={TICK} strokeLinecap="round" />
          <circle cx={CLOCK.cx} cy={CLOCK.cy} r={4} fill={FG} />
        </Disc>
        <Hole cx={moon.cx} cy={moon.cy} r={17} fill={RAISED} />
        <g transform={`translate(${moon.cx - 12} ${moon.cy - 12}) scale(1.2)`}>
          <path d={ICON_PATHS.moon.d} fill={K.accent} />
        </g>
      </El>

      {/* still armed: the alarm, on its dot in the alarm's tone */}
      <El name="alarm">
        <Plate k={K} x={ROWS.x} y={a.y} w={ROWS.w} h={a.h} r={8} d={8}>
          <G name="dot" x={ROWS.x + 12} y={a.y + 12} size={24} color="var(--jh-mark)" />
          <Value x={ROWS.x + 46} y={a.y + 30} size={14}>
            {ALARM}
          </Value>
          <Label x={ROWS.x + ROWS.w - 16} y={a.y + 30} anchor="end" color={QUIET}>
            {WEEKDAYS}
          </Label>
          <Label x={ROWS.x + 46} y={a.y + 54} color={QUIET}>
            {ISLAND.alarmSub}
          </Label>
        </Plate>
      </El>

      {/* still armed: the timer from the asleep line, on the hourglass */}
      <El name="timer">
        <Plate k={K} x={ROWS.x} y={t.y} w={ROWS.w} h={t.h} r={8} d={8}>
          <G name="hourglass" x={ROWS.x + 12} y={t.y + 11} size={24} color={FG} />
          <Value x={ROWS.x + 46} y={t.y + 28} size={14}>
            {TIMER}
          </Value>
        </Plate>
      </El>
    </Art>
  );
}
