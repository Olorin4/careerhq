import type { RawFormPage } from "./raw.js";

/**
 * ATS detection from structural markers only — no network calls, no DOM.
 *
 * greenhouse: rootMarkers/url mention "greenhouse", or a rootMarker carries
 *   the real Greenhouse embed's `id="application_form"` convention → 0.95.
 * lever: rootMarkers/url mention "lever", or any field name uses Lever's
 *   `cards[...]` naming convention → 0.95.
 * else: generic, low confidence.
 */
export function detectAts(page: RawFormPage): { atsType: "greenhouse" | "lever" | "generic"; confidence: number } {
  const haystack = [page.url, ...page.rootMarkers].join(" ");

  const looksGreenhouse =
    /greenhouse/i.test(haystack) || page.rootMarkers.some((marker) => marker.includes("application_form"));
  if (looksGreenhouse) return { atsType: "greenhouse", confidence: 0.95 };

  const looksLever = /lever/i.test(haystack) || page.fields.some((field) => field.name.startsWith("cards["));
  if (looksLever) return { atsType: "lever", confidence: 0.95 };

  return { atsType: "generic", confidence: 0.4 };
}
