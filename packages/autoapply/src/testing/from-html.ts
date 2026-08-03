// Shared fixture helper: builds a RawFormPage from a static HTML string using
// linkedom. This implements the SAME extraction rules (labelText, nearbyText,
// step, selector) that the Playwright driver (Task 8) implements in browser
// JS — keeping one place honest so Task 8 can assert parity against it.
//
// Not part of the package's runtime surface: exported only via the
// "@careerhq/autoapply/testing" subpath so the (devDependency-only)
// `linkedom` import never reaches production code paths.
import { parseHTML } from "linkedom";
import type { RawField, RawFormPage } from "../raw.js";

type Doc = ReturnType<typeof parseHTML>["document"];
type El = ReturnType<Doc["querySelector"]>;

const CAPTCHA_MARKER_RE = /recaptcha|hcaptcha|turnstile|cf-challenge/i;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isSimpleIdent(id: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(id);
}

function escapeAttrValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function nthOfTypePath(el: NonNullable<El>): string {
  const parts: string[] = [];
  let node: NonNullable<El> | null = el;
  while (node && node.tagName && node.tagName !== "HTML" && node.tagName !== "BODY") {
    const id = node.getAttribute("id");
    if (id && isSimpleIdent(id)) {
      parts.unshift(`#${id}`);
      break;
    }
    const tag = node.tagName.toLowerCase();
    const parent = node.parentElement as NonNullable<El> | null;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
    const idx = siblings.indexOf(node) + 1;
    parts.unshift(`${tag}:nth-of-type(${idx})`);
    node = parent;
  }
  return parts.join(" > ") || el.tagName.toLowerCase();
}

function buildSelector(document: Doc, el: NonNullable<El>): string {
  const id = el.getAttribute("id");
  if (id && isSimpleIdent(id)) {
    const sel = `#${id}`;
    if (document.querySelectorAll(sel).length === 1) return sel;
  }
  const name = el.getAttribute("name");
  const tag = el.tagName.toLowerCase();
  if (name) {
    const byName = `${tag}[name="${escapeAttrValue(name)}"]`;
    if (document.querySelectorAll(byName).length === 1) return byName;
    const value = el.getAttribute("value");
    if (value) {
      const byNameValue = `${tag}[name="${escapeAttrValue(name)}"][value="${escapeAttrValue(value)}"]`;
      if (document.querySelectorAll(byNameValue).length === 1) return byNameValue;
    }
  }
  return nthOfTypePath(el);
}

function resolveLabelText(document: Doc, el: NonNullable<El>): string {
  const id = el.getAttribute("id");
  if (id) {
    const forLabel = document.querySelector(`label[for="${escapeAttrValue(id)}"]`);
    if (forLabel) return collapse(forLabel.textContent ?? "");
  }
  const wrapping = el.closest("label");
  if (wrapping) return collapse(wrapping.textContent ?? "");
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return collapse(ariaLabel);
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const texts: string[] = [];
    for (const refId of labelledBy.split(/\s+/).filter(Boolean)) {
      const target = document.getElementById(refId);
      if (!target) continue;
      const text = collapse(target.textContent ?? "");
      if (text) texts.push(text);
    }
    if (texts.length > 0) return texts.join(" ");
  }
  return "";
}

function nearestDivAncestor(el: NonNullable<El>): El | null {
  let node = el.parentElement as NonNullable<El> | null;
  while (node) {
    if (node.tagName === "DIV") return node;
    node = node.parentElement as NonNullable<El> | null;
  }
  return null;
}

function resolveNearbyText(el: NonNullable<El>): string {
  const container = el.closest(".field, fieldset") ?? nearestDivAncestor(el) ?? el.parentElement ?? el;
  return collapse(container.textContent ?? "").slice(0, 400);
}

function collectRootMarkers(document: Doc): string[] {
  const markers: string[] = [];
  const seen = new Set<string>();
  const push = (marker: string) => {
    if (!seen.has(marker)) {
      seen.add(marker);
      markers.push(marker);
    }
  };

  let node = (document.querySelector("form") ?? document.body) as NonNullable<El> | null;
  while (node && node.tagName !== "HTML") {
    const id = node.getAttribute("id");
    if (id) push(`id=${id}`);
    const dataSource = node.getAttribute("data-source");
    if (dataSource) push(`data-source=${dataSource}`);
    const cls = node.getAttribute("class");
    if (cls) push(`class=${cls}`);
    node = node.parentElement as NonNullable<El> | null;
  }

  for (const el of Array.from(document.querySelectorAll("[class]"))) {
    const cls = el.getAttribute("class") ?? "";
    if (CAPTCHA_MARKER_RE.test(cls)) push(`class=${cls}`);
  }

  return markers;
}

export function rawPageFromHtml(html: string, url: string): RawFormPage {
  const { document } = parseHTML(html);

  const title = collapse(document.querySelector("title")?.textContent ?? "");
  const bodyText = collapse(document.body?.textContent ?? "").slice(0, 20_000);
  const rootMarkers = collectRootMarkers(document);

  const stepEls = Array.from(document.querySelectorAll("[data-step]"));
  const stepValues = [
    ...new Set(
      stepEls
        .map((el) => el.getAttribute("data-step"))
        .filter((v): v is string => v !== null),
    ),
  ].sort((a, b) => Number(a) - Number(b));
  const totalSteps = stepValues.length || 1;

  function stepIndexFor(el: NonNullable<El>): number {
    const stepEl = el.closest("[data-step]");
    if (!stepEl) return 0;
    const v = stepEl.getAttribute("data-step");
    if (v === null) return 0;
    const idx = stepValues.indexOf(v);
    return idx === -1 ? 0 : idx;
  }

  const fieldEls = Array.from(document.querySelectorAll("input, textarea, select")) as Array<NonNullable<El>>;
  const fields: RawField[] = fieldEls.map((el) => {
    const tag = el.tagName.toLowerCase() as "input" | "textarea" | "select";
    const type = tag === "input" ? el.getAttribute("type") || "text" : "";
    const options =
      tag === "select"
        ? Array.from(el.querySelectorAll("option")).map((opt) => ({
            value: opt.getAttribute("value") ?? collapse(opt.textContent ?? ""),
            label: collapse(opt.textContent ?? ""),
          }))
        : [];
    const maxLengthAttr = el.getAttribute("maxlength");
    const maxLength =
      maxLengthAttr !== null && maxLengthAttr !== "" && Number.isFinite(Number(maxLengthAttr))
        ? Number(maxLengthAttr)
        : null;
    const required = el.hasAttribute("required") || el.getAttribute("aria-required") === "true";

    return {
      selector: buildSelector(document, el),
      tag,
      type,
      name: el.getAttribute("name") ?? "",
      id: el.getAttribute("id") ?? "",
      labelText: resolveLabelText(document, el),
      nearbyText: resolveNearbyText(el),
      placeholder: el.getAttribute("placeholder") ?? "",
      required,
      maxLength,
      accept: el.getAttribute("accept"),
      options,
      step: stepIndexFor(el),
    };
  });

  const buttons = (Array.from(document.querySelectorAll("button")) as Array<NonNullable<El>>).map((el) => ({
    selector: buildSelector(document, el),
    id: el.getAttribute("id") ?? "",
    text: collapse(el.textContent ?? ""),
  }));

  return { url, title, bodyText, rootMarkers, fields, buttons, totalSteps };
}
