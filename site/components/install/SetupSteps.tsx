import { SETUP_HEAD, SETUP_STEPS } from "@/content/install";
import { RichText } from "./CommandRows";

/** Seven numbered rows under `Setup · 7`: a mono number column, the step's name at 500, its line in --jh-fg-2. */
export function SetupSteps() {
  return (
    <div className="ins-list">
      <h3 className="ins-list-head">
        {SETUP_HEAD.word}
        <span className="ins-list-count"> · {SETUP_HEAD.count}</span>
      </h3>
      <ol className="ins-steps">
        {SETUP_STEPS.map((s) => (
          <li key={s.n} className="ins-step">
            <span className="ins-step-n">{s.n}</span>
            <span className="ins-step-text">
              <span className="ins-step-name">{s.name}</span>
              <span className="ins-step-line">
                {" · "}
                <RichText parts={s.line} />
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
