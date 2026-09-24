import { ThemeToggle } from "@/components/ThemeToggle";

export default function Page() {
  return (
    <main style={{ padding: 32 }}>
      <h1 style={{ fontWeight: 600, letterSpacing: "-0.02em" }}>Jarhead</h1>
      <p style={{ color: "var(--jh-fg-2)" }}>A voice-first Mac assistant that uses the computer for you.</p>
      <ThemeToggle />
    </main>
  );
}
