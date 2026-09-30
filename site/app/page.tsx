import { Composer } from "@/components/console/Composer";
import { Ground } from "@/components/console/Ground";
import { LeftRail } from "@/components/console/LeftRail";
import { RightRail } from "@/components/console/RightRail";
import { TitleBar } from "@/components/console/TitleBar";
import { Costs } from "@/components/console/stream/Costs";
import { Foot } from "@/components/console/stream/Foot";
import { Hands } from "@/components/console/stream/Hands";
import { Hero } from "@/components/console/stream/Hero";
import { Install } from "@/components/console/stream/Install";
import { Made } from "@/components/console/stream/Made";
import { Numbers } from "@/components/console/stream/Numbers";
import { Rails } from "@/components/console/stream/Rails";
import { Say } from "@/components/console/stream/Say";
import { Sleep } from "@/components/console/stream/Sleep";
import { Threads } from "@/components/console/stream/Threads";
import { Wake } from "@/components/console/stream/Wake";
import { NAV } from "@/content/deck";
import { fetchStars } from "@/lib/stars";

/**
 * THE CONSOLE IS THE SITE (IMMERSE.md angle A; ITERATE.md's seven asks): one Console window fills the page on the
 * dithered ground. The sticky title bar with the traffic lights, `Jarhead · <phase>` and GitHub's star count; the sticky
 * rail with the sections, the app's own threads, conversations and agents; the Now stream, its first conversation the
 * notch and the island with the blob's face, then every section as two columns (words beside one framed picture, the
 * picture side alternating); the composer at the stream's foot (the install field while Install is in view); the right
 * rail with Session · Audio · Permissions and the group of the conversation in view. Phone: the rail becomes the strip
 * under the title bar; each rail group folds into its section.
 */
export default async function Page() {
  const stars = await fetchStars();
  return (
    <>
      <a href="#main" className="jh-skip">{NAV.skip}</a>
      <Ground />
      <div className="shell" data-desk-stage="">
        <TitleBar stars={stars} />
        <div className="panes">
          <LeftRail />
          <main id="main" className="stream">
            <Hero stars={stars} />
            <Wake />
            <Say />
            <Threads />
            <Hands />
            <Rails />
            <Sleep />
            <Numbers />
            <Costs />
            <Made />
            <Install />
            <Foot />
            <Composer />
          </main>
          <RightRail />
        </div>
      </div>
    </>
  );
}
