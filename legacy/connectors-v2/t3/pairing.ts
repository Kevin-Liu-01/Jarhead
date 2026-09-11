/**
 * T3 Code hands out pairing credentials as a URL, `<origin>/pair#token=<credential>`
 * (the token sits in the hash so it never reaches server logs). Kevin may paste
 * that URL, a `?token=` variant, or just the credential itself.
 */
export interface PairingInput {
  readonly credential: string;
  /** Origin of the pairing URL, when one was given; the exchange must go there. */
  readonly baseUrl?: string;
}

export function parsePairingInput(input: string): PairingInput | undefined {
  const text = input.trim();
  if (text.length === 0) return undefined;

  if (/^https?:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return undefined;
    }
    const credential = credentialFromFragment(url.hash) ?? credentialFromQuery(url.searchParams);
    if (!credential) return undefined;
    return { credential, baseUrl: url.origin };
  }

  // A bare credential never contains whitespace; anything else is a paste mistake.
  if (/\s/.test(text)) return undefined;
  return { credential: text };
}

function credentialFromFragment(hash: string): string | undefined {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (fragment.length === 0) return undefined;
  if (!fragment.includes("=")) return decodeURIComponent(fragment);
  const params = new URLSearchParams(fragment);
  return nonEmpty(params.get("token")) ?? nonEmpty(params.get("credential"));
}

function credentialFromQuery(params: URLSearchParams): string | undefined {
  return nonEmpty(params.get("token")) ?? nonEmpty(params.get("credential"));
}

function nonEmpty(value: string | null): string | undefined {
  return value !== null && value.length > 0 ? value : undefined;
}
