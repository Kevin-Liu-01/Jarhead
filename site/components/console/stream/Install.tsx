import type { CSSProperties, ReactElement } from "react";
import { CopyButton } from "@/components/install/CopyButton";
import { Glyph, Group, Row, type GlyphName } from "@/components/kit";
import { INSTALL, SHOTS } from "@/content/deck";
import { from, upTo } from "@/lib/cut";
import { InstallRail } from "../railGroups";
import { Sec, Tone } from "./parts";

/** The note's last two sentences, whole; the URL closes it and renders as the link. */
const NOTE = from(INSTALL.note, 3);
const NOTE_HEAD = upTo(NOTE, INSTALL.url);
if (!NOTE.endsWith(INSTALL.url)) throw new Error("the plate note no longer ends with the script's URL");
/** The lead from its second sentence: the title row's `source only` label already says the first. */
const LEAD = from(INSTALL.lead, 1); // One line clones the repo and runs four commands. Setup opens on first launch and writes your key.
/** A glyph per Setup step (the wizard's own rail, onboarding-permissions.png): Welcome · Voice · Brain · Permissions · Wake · Agents · Done. */
const STEP_GLYPHS: readonly GlyphName[] = ["play", "voice", "ask", "lock", "mic", "terminal", "checkCircle"];
/** The dots the capture shows: settled on Voice, Brain and Wake, the current step amber, none on the rest. */
const STEP_DOTS: ReadonlyArray<"acting" | "speaking" | null> = [null, "acting", "acting", "speaking", "acting", null, null];
const CURRENT = 3; // Permissions: the step the capture shows
if (STEP_GLYPHS.length !== INSTALL.steps.length || STEP_DOTS.length !== INSTALL.steps.length) throw new Error("a Setup step has no glyph");

/** The capture is the wizard at 1× (620 × 552): the drawn window keeps its title bar and rail and shows the pane through the frame (x from 170, y from 36). */
const PANE = { x: 170, y: 36, w: 450, h: 516 } as const;

/**
 * Install as a Console pane (IMMERSE.md §7): the h2 and the lead, the note with the linked script; the four commands as
 * tool rows headed by the h2 itself, so `Four commands` is said once (terminal glyph, mono title, the README comment as
 * the meta line, a ghost Copy in the verb slot), the spoken fifth row; the three lines; then the Setup wizard drawn as a
 * window (its title bar, the seven-step rail with the wizard's glyphs and status dots, Permissions selected) holding its
 * Permissions pane at 1×. The one-liner is the stream's composer while this conversation is in view (console/Composer.tsx);
 * Requirements is the rail's group.
 */
export function Install(): ReactElement {
  return (
    <Sec id={INSTALL.id} name={INSTALL.name} label={INSTALL.label} h2={INSTALL.h2} lead={LEAD} rail={<InstallRail />}>
      <p className="ins-note">
        {NOTE_HEAD}
        <a href={INSTALL.url} rel="noopener">
          {INSTALL.url}
        </a>
      </p>
      <Group className="ins-cmds">
        {INSTALL.commands.map((c) => (
          <Row
            key={c.cmd}
            size={13}
            mono
            icon={<Tone name="terminal" />}
            title={c.cmd}
            meta={"note" in c ? c.note : undefined}
            trailing={
              <span className="kit-row-verb">
                <CopyButton text={c.cmd} kind="ghost" size={24} />
              </span>
            }
          />
        ))}
        <Row size={13} icon={<Tone name="mic" tone="listening" />} title={INSTALL.then} />
      </Group>
      <ul role="list" className="kit-rows sec-rows">
        <Row size={13} icon={<Tone name="key" />} title={INSTALL.lines[0]} />
        <Row size={13} icon={<Tone name="checkCircle" tone="acting" />} title={INSTALL.lines[1]} />
        <Row size={13} icon={<Tone name="terminal" />} title={INSTALL.lines[2]} />
      </ul>
      <div className="wiz" role="group" aria-label={INSTALL.setup}>
        <div className="wiz-head">
          <span className="wiz-lights" aria-hidden="true">
            <i className="tb-light tb-light-r" />
            <i className="tb-light tb-light-y" />
            <i className="tb-light tb-light-g" />
          </span>
          <span className="wiz-name">{INSTALL.setupWord}</span>
          <span className="wiz-count">{INSTALL.steps.length}</span>
        </div>
        <div className="wiz-body">
          <ul role="list" className="kit-rows wiz-rail">
            {INSTALL.steps.map((s, i) => {
              const dot = STEP_DOTS[i];
              return (
                <Row
                  key={s}
                  icon={<Glyph name={STEP_GLYPHS[i] ?? "dot"} size={16} />}
                  title={s}
                  selected={i === CURRENT}
                  trailing={dot ? <span className="kit-dot" style={{ "--kit-phase": `var(--jh-${dot})` } as CSSProperties} aria-hidden="true" /> : undefined}
                />
              );
            })}
          </ul>
          <div className="wiz-pane">
            <div className="wiz-crop" style={{ width: PANE.w, height: PANE.h }}>
              <img src={SHOTS.setupPermissions.src} alt={SHOTS.setupPermissions.alt} width={SHOTS.setupPermissions.width} height={SHOTS.setupPermissions.height} style={{ marginLeft: -PANE.x, marginTop: -PANE.y }} decoding="async" loading="lazy" />
            </div>
          </div>
        </div>
      </div>
    </Sec>
  );
}
