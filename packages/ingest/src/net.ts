// Polite fetching, spec §5.1 / ADR-0006: every board operator we fetch from can
// see who is asking and reach a page that says what this is. The URL is the
// hosted demo, deliberately NOT the source repo — the point of a contact URL is
// that a human on the other end can open it and understand the traffic, and a
// running instance says that faster than a README. Bump the version with the
// phase so a log line dates itself.
export const INGEST_USER_AGENT = "CareerHQ/0.6 (+https://careerhq.nickkalas.dev)";
const DEFAULT_TIMEOUT_MS = 15_000;

export class IngestFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function request(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": INGEST_USER_AGENT, Accept: "application/json, application/rss+xml, text/xml, */*" },
      signal: controller.signal,
    });
    if (!res.ok) throw new IngestFetchError(`GET ${url} → ${res.status}`, res.status);
    return res;
  } catch (err) {
    if (err instanceof IngestFetchError) throw err;
    throw new IngestFetchError(`GET ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url: string, opts?: { timeoutMs?: number }): Promise<unknown> {
  return (await request(url, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS)).json();
}
export async function fetchText(url: string, opts?: { timeoutMs?: number }): Promise<string> {
  return (await request(url, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS)).text();
}
