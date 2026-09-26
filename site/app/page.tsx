import { Footer } from "@/components/Footer";
import { Hero } from "@/components/Hero";
import { InstallBand } from "@/components/install/InstallBand";
import { Nav } from "@/components/Nav";
import { Costs } from "@/components/sections/Costs";
import { Hands } from "@/components/sections/Hands";
import { Made } from "@/components/sections/Made";
import { Numbers } from "@/components/sections/Numbers";
import { Rails } from "@/components/sections/Rails";
import { Say } from "@/components/sections/Say";
import { Sleep } from "@/components/sections/Sleep";
import { Story } from "@/components/sections/Story";
import { Threads } from "@/components/sections/Threads";
import { Hatch } from "@/components/ui/Hatch";
import { NAV } from "@/content/deck";

/**
 * Mailroom's page anatomy (MAILROOM.md §1; layout.tsx:45-74, page.tsx:28-136): header.rail → hatch.rail → main.rail
 * (the sections separated by a hatch band with four corner crosses) → hatch.rail → footer.rail. Every band shares one
 * bordered column; nothing is full-bleed.
 */
export default function Page() {
  return (
    <>
      <a href="#main" className="jh-skip">{NAV.skip}</a>
      <Nav />
      <Hatch rail />
      <main id="main" className="jh-rail">
        <Hero />
        <Hatch crosses />
        <Story />
        <Hatch crosses />
        <Say />
        <Hatch crosses />
        <Threads />
        <Hatch crosses />
        <Hands />
        <Hatch crosses />
        <Rails />
        <Hatch crosses />
        <Sleep />
        <Hatch crosses />
        <Numbers />
        <Hatch crosses />
        <Costs />
        <Hatch crosses />
        <Made />
        <Hatch crosses />
        <InstallBand />
      </main>
      <Hatch rail />
      <Footer />
    </>
  );
}
