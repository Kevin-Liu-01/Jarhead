import { INSTALL } from "@/content/deck";
import { CopyButton } from "./CopyButton";

/**
 * The one-liner's four held runs. It may wrap only after `curl -fsSL`, before `install.sh` and before `| sh`, never
 * inside the host; the text stays byte-identical to INSTALL.code, which is what Copy copies.
 */
const CMD = "curl -fsSL";
const SCRIPT = "install.sh";
const TAIL = "| sh";
const HOST = INSTALL.url.slice(0, -SCRIPT.length);
if (!INSTALL.url.endsWith(SCRIPT) || `${CMD} ${HOST}${SCRIPT} ${TAIL}` !== INSTALL.code) throw new Error("the one-liner's runs drifted from INSTALL.code");

/** The one-liner strip: the command in mono on the ink surface, then the kit primary Copy. The note under it links the script. */
export function InstallStrip() {
  return (
    <div className="ins-strip">
      <code className="ins-strip-code">
        <span className="ins-strip-seg">{CMD}</span> <span className="ins-strip-seg">{HOST}</span>
        <wbr />
        <span className="ins-strip-seg">{SCRIPT}</span> <span className="ins-strip-seg">{TAIL}</span>
      </code>
      <div className="ins-strip-acts">
        <CopyButton text={INSTALL.code} label={`${INSTALL.copy}: ${INSTALL.code}`} />
      </div>
    </div>
  );
}
