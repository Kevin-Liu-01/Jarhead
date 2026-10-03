import { stillResponse } from "@/lib/still";

/** /stills/happy.png: the blob's happy still, rendered once at build (lib/still.ts). */
export const dynamic = "force-static";

export function GET(): Response {
  return stillResponse("happy");
}
