import { Footer } from "@/components/Footer";
import { Hero } from "@/components/Hero";
import { Nav } from "@/components/Nav";
import { Install } from "@/components/install/Install";
import { Costs } from "@/components/sections/Costs";
import { Hands } from "@/components/sections/Hands";
import { Made } from "@/components/sections/Made";
import { Numbers } from "@/components/sections/Numbers";
import { Rails } from "@/components/sections/Rails";
import { Say } from "@/components/sections/Say";
import { Sleep } from "@/components/sections/Sleep";
import { Threads } from "@/components/sections/Threads";
import { Wake } from "@/components/sections/Wake";
import { Hatch } from "@/components/ui/Hatch";

export default function Page() {
  return (
    <>
      <a href="#main" className="jh-skip">Skip to content</a>
      <Nav />
      <main id="main" className="jh-rail">
        <Hero />
        <Hatch />
        <Wake />
        <Say />
        <Threads />
        <Hands />
        <Rails />
        <Sleep />
        <Hatch />
        <Numbers />
        <Costs />
        <Made />
        <Hatch />
        <Install />
      </main>
      <Footer />
    </>
  );
}
