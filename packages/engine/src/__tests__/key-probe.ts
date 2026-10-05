/**
 * OpenAI's answer to world()'s fake key, on this Mac (W2-9). The engine checks its key once at
 * start (`probeSetup`: GET https://api.openai.com/v1/models/<live model>). A test that reads the
 * problem list whole needs that check to land the same way under the preload's two modes: a 401
 * when off-Mac fetch is answered, a throw (a 'could not reach api.openai.com' row) under
 * JARHEAD_TEST_NET=strict. Installed in such a file, the check gets the 401 OpenAI gives a key it
 * does not know, here, with no request made. Every other request goes on to the preload's fetch, so
 * anything else off the Mac still fails by name under strict.
 */
export function answerKeyProbe(): void {
  const next = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request ? request.url : String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    if (method === "GET" && url.origin === "https://api.openai.com" && url.pathname.startsWith("/v1/models/")) {
      return Response.json({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 });
    }
    return next(input, init);
  }) as typeof fetch;
}
