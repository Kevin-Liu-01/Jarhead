import { Button, Tip } from "@/components/kit";
import { DitherGround } from "@/components/ui/DitherGround";
import { after, upTo } from "@/components/sections/cut";
import { INSTALL_URL, ONE_LINER, PLATE_COPY_LABEL, PLATE_NOTE_DESK } from "@/content/install";
import { CopyButton } from "./CopyButton";

/**
 * The one-liner's four held runs. It may wrap only after `curl -fsSL`, before `install.sh` and before
 * `| sh`, never inside the host; the text stays byte-identical to ONE_LINER, which is what Copy copies.
 */
const CMD = "curl -fsSL";
const SCRIPT = "install.sh";
const TAIL = "| sh";
const HOST = INSTALL_URL.slice(0, -SCRIPT.length);
if (!INSTALL_URL.endsWith(SCRIPT) || `${CMD} ${HOST}${SCRIPT} ${TAIL}` !== ONE_LINER) throw new Error("the one-liner's runs drifted from ONE_LINER");

/** The Copy's tip: the first clause of the deck's note (README:23-29; scripts/install.sh header). Verb first, no full stop, 48 characters. */
const COPY_TIP = upTo(PLATE_NOTE_DESK, ". macOS");
/** "Read it first" is the note's own verb (README:352-355; scripts/install.sh header). */
const READ = upTo(after(PLATE_NOTE_DESK, "pnpm 10. "), ": ");

/**
 * The one-liner strip: the ink field with the accent as a corner whisper, the command in mono 15 at the left, the
 * two verbs at the right: the ghost that opens the script, then the kit primary Copy with its tip.
 */
export function InstallStrip() {
  return (
    <div className="ins-strip">
      <DitherGround variant="ink" cell={3} className="ins-strip-field" />
      <code className="ins-strip-code">
        <span className="ins-strip-seg">{CMD}</span> <span className="ins-strip-seg">{HOST}</span>
        <wbr />
        <span className="ins-strip-seg">{SCRIPT}</span> <span className="ins-strip-seg">{TAIL}</span>
      </code>
      <div className="ins-strip-acts">
        <Button kind="ghost" size={32} href={INSTALL_URL} glyph="externalLink">
          {READ}
        </Button>
        <Tip line={COPY_TIP}>
          <CopyButton text={ONE_LINER} label={PLATE_COPY_LABEL} />
        </Tip>
      </div>
    </div>
  );
}
