import { Fragment } from "react";
import { COMMANDS, type Rich } from "@/content/install";
import { CopyButton } from "./CopyButton";

/** Renders a Rich run: strings as text, `{ code }` as <code>. Shared by the Install lane's lists. */
export function RichText({ parts }: { readonly parts: Rich }) {
  return <>{parts.map((p, i) => (typeof p === "string" ? p : <code key={i}>{p.code}</code>))}</>;
}

/** A command verbatim, with a line-break opportunity only before each `&&`: a chained command never wraps mid-word on the rail. */
function Command({ cmd }: { readonly cmd: string }) {
  const parts = cmd.split(" && ");
  return (
    <code className="ins-row-cmd">
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 ? " " : null}
          <span className="ins-cmd-seg">{i > 0 ? `&& ${part}` : part}</span>
        </Fragment>
      ))}
    </code>
  );
}

/**
 * The four numbered rows, each with its own Copy, then the spoken fifth without one. A row owns its
 * top rule (--jh-hair-row); the number column is mono.
 */
export function CommandRows() {
  return (
    <ol className="ins-rows">
      {COMMANDS.map((row) =>
        row.kind === "command" ? (
          <li key={row.n} className="ins-row">
            <span className="ins-row-n">{row.n}</span>
            <div className="ins-row-body">
              <Command cmd={row.cmd} />
              <p className="ins-row-note">
                <RichText parts={row.note} />
              </p>
            </div>
            <div className="ins-row-copy">
              <CopyButton text={row.cmd} size="sm" />
            </div>
          </li>
        ) : (
          <li key={row.n} className="ins-row ins-row--spoken">
            <span className="ins-row-n">{row.n}</span>
            <p className="ins-row-text">
              <RichText parts={row.text} />
            </p>
          </li>
        ),
      )}
    </ol>
  );
}
