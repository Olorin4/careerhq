/**
 * How this app identifies itself to OpenRouter.
 *
 * `HTTP-Referer` and `X-Title` are what OpenRouter shows in its activity view
 * and its public app rankings, so they should point at something a human can
 * open — the hosted demo, not the source repository. Both the JSON-mode client
 * and the streaming client send the same pair; they live here so the two can
 * never drift apart, which is exactly how the previous placeholder survived in
 * two files at once.
 */
export const OPENROUTER_APP_REFERER = "https://careerhq.nickkalas.dev";
export const OPENROUTER_APP_TITLE = "CareerHQ";
