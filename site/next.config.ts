import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Next 16 would otherwise write AGENTS.md and CLAUDE.md into site/ on every dev start.
  agentRules: false,
  // The captures are the repo's own files, served as they are: a dithered JPEG must never be re-encoded.
  images: { unoptimized: true },
  async headers() {
    return [
      {
        // The installer is a shell script: served as text, never cached long, never sniffed.
        source: "/install.sh",
        headers: [
          { key: "Content-Type", value: "text/x-shellscript; charset=utf-8" },
          { key: "Cache-Control", value: "public, max-age=300, must-revalidate" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default config;
