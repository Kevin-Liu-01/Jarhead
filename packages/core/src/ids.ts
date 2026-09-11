import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Short ids: <prefix>_<base36 time><6 random chars>. Sortable enough for logs. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36);
  let rand = "";
  for (const b of randomBytes(6)) rand += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${time}${rand}`;
}
