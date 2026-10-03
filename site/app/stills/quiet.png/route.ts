import { stillResponse } from "@/lib/still";

/** /stills/quiet.png: the blob's quiet still, rendered once at build (lib/still.ts). */
export const dynamic = "force-static";

export function GET(): Response {
  return stillResponse("quiet");
}
