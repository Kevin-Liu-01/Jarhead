import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CardScene } from "./CardScene";
import { FRAMES, tuned } from "./frames";
import "./card.css";

/**
 * /card?f=<frame>: the Open Graph card, the GitHub social preview, the README banners and the README's GIF, composed from
 * the page's own pieces (app/card/frames.ts) for scripts/make-cards.sh to capture. Development only: production answers
 * 404 and nothing links here. Any of the frame's numbers can be tried from the query (frames.ts `tuned`); `gif` exposes
 * the stepper the GIF is taken with.
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

type Query = Record<string, string | string[] | undefined>;

export default async function CardPage({ searchParams }: { readonly searchParams: Promise<Query> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const q = await searchParams;
  const one: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) if (typeof v === "string") one[k] = v;
  const frame = FRAMES[one["f"] ?? "og-light"];
  if (!frame) notFound();
  return <CardScene frame={tuned(frame, one)} gif={one["gif"] !== undefined} />;
}
