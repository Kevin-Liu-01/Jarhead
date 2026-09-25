import { Desk, DeskCaption } from "@/components/desk/Desk";

/** The fold: the headline row (h1, the lead, the figures line), then the drawn Mac and its one caption line. */
export function Hero() {
  return (
    <header id="top" className="jh-hero">
      <div className="jh-hero-row">
        <h1 className="jh-h1">Say jarhead. Pass Touch&nbsp;ID. Talk.</h1>
        <div>
          <p className="jh-lead">
            A voice-first Mac assistant that uses the computer for you. The voice is GPT-Live-1, full duplex. The brain is whatever you already have a login for. The hands are a Swift helper on the real Mac.
          </p>
          <p className="jh-fig">v2.0.0 · MIT · macOS 14+ · Apple silicon · $0.05 / min, per second · 71 tools · 6 brains + auto</p>
        </div>
      </div>
      <Desk />
      <DeskCaption />
    </header>
  );
}
