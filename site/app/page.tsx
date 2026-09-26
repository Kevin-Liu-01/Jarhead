import { Footer } from "@/components/Footer";
import { Hero } from "@/components/Hero";
import { Install } from "@/components/install/Install";
import { Nav } from "@/components/Nav";
import { Hands } from "@/components/sections/Hands";
import { Numbers } from "@/components/sections/Numbers";
import { Rails } from "@/components/sections/Rails";
import { Say } from "@/components/sections/Say";
import { Sleep } from "@/components/sections/Sleep";
import { Wake } from "@/components/sections/Wake";

/** The rail: the hero's three rows (words · the stage · the phase control), then one head and one plate per section, Install first, one hairline per boundary. */
export default function Page() {
  return (
    <>
      <a href="#main" className="jh-skip">Skip to content</a>
      <Nav />
      <main id="main" className="jh-rail">
        <Hero />
        <Install />
        <Wake />
        <Say />
        <Hands />
        <Rails />
        <Sleep />
        <Numbers />
      </main>
      <Footer />
    </>
  );
}
