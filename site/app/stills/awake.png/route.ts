import { stillResponse } from "@/lib/still";

/** /stills/awake.png: the blob's awake still, rendered once at build (lib/still.ts). */
export const dynamic = "force-static";

export function GET(): Response {
  return stillResponse("awake");
}
