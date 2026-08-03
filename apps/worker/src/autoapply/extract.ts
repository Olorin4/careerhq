// The in-page extractor: the only code in the system that touches a live DOM.
//
// `extractFromDocument` is written as ONE self-contained function (every helper
// nested, no imports at runtime, types only) for a single reason: the string the
// browser evaluates is built from this function's own source —
//
//     EXTRACT_SCRIPT = `(${extractFromDocument.toString()})(document)`
//
// so the browser and the test run byte-identical logic. That is what lets the
// parity assertion against `@careerhq/autoapply/testing`'s `rawPageFromHtml`
// (linkedom, no browser) actually mean something: if these rules ever drift,
// the browser-free test fails first. Any helper hoisted to module scope would
// be `undefined` inside `page.evaluate`, so KEEP THEM NESTED.
//
// The rules mirrored from that helper, verbatim:
//   - labelText: <label for> → wrapping <label> → aria-label → aria-labelledby
//   - nearbyText: closest .field/fieldset → nearest <div> → parent, collapsed, <=400
//   - selector: #id → tag[name=] (→ tag[name=][value=]) → nth-of-type path
//   - step: 0-based index of the enclosing [data-step] section
import type { RawField, RawFormPage } from "@careerhq/autoapply";

/**
 * The slice of the DOM the extractor needs. `apps/worker` compiles without the
 * DOM lib (it is a Node service), and the same code has to type-check against
 * linkedom's document in tests — a structural interface satisfies both without
 * pulling browser globals into the worker's type environment.
 */
export interface ExtractElement {
  readonly tagName: string;
  readonly textContent: string | null;
  readonly parentElement: ExtractElement | null;
  readonly children: ArrayLike<ExtractElement>;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  closest(selector: string): ExtractElement | null;
  querySelectorAll(selector: string): ArrayLike<ExtractElement>;
}

export interface ExtractDocument {
  readonly body: ExtractElement | null;
  querySelector(selector: string): ExtractElement | null;
  querySelectorAll(selector: string): ArrayLike<ExtractElement>;
  getElementById(id: string): ExtractElement | null;
}

/**
 * Everything the DOM can tell us. `url` comes from the driver (the browser may
 * have redirected) and `totalSteps` is derived by `deriveTotalSteps` — see
 * there for why step counting is the driver's job, not the page's.
 */
export type ExtractedPage = Omit<RawFormPage, "url" | "totalSteps">;

export function extractFromDocument(document: ExtractDocument): ExtractedPage {
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

  function nthOfTypePath(el: ExtractElement): string {
    const parts: string[] = [];
    let node: ExtractElement | null = el;
    while (node && node.tagName && node.tagName !== "HTML" && node.tagName !== "BODY") {
      const id = node.getAttribute("id");
      if (id && isSimpleIdent(id)) {
        parts.unshift("#" + id);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent: ExtractElement | null = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter((c) => c.tagName === node?.tagName);
      const idx = siblings.indexOf(node) + 1;
      parts.unshift(tag + ":nth-of-type(" + idx + ")");
      node = parent;
    }
    return parts.join(" > ") || el.tagName.toLowerCase();
  }

  function buildSelector(el: ExtractElement): string {
    const id = el.getAttribute("id");
    if (id && isSimpleIdent(id)) {
      const sel = "#" + id;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }
    const name = el.getAttribute("name");
    const tag = el.tagName.toLowerCase();
    if (name) {
      const nameClause = '[name="' + escapeAttrValue(name) + '"]';
      const byName = tag + nameClause;
      if (document.querySelectorAll(byName).length === 1) return byName;
      const value = el.getAttribute("value");
      if (value) {
        const byNameValue = tag + nameClause + '[value="' + escapeAttrValue(value) + '"]';
        if (document.querySelectorAll(byNameValue).length === 1) return byNameValue;
      }
    }
    return nthOfTypePath(el);
  }

  function resolveLabelText(el: ExtractElement): string {
    const id = el.getAttribute("id");
    if (id) {
      const forLabel = document.querySelector('label[for="' + escapeAttrValue(id) + '"]');
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

  function nearestDivAncestor(el: ExtractElement): ExtractElement | null {
    let node: ExtractElement | null = el.parentElement;
    while (node) {
      if (node.tagName === "DIV") return node;
      node = node.parentElement;
    }
    return null;
  }

  function resolveNearbyText(el: ExtractElement): string {
    const container = el.closest(".field, fieldset") ?? nearestDivAncestor(el) ?? el.parentElement ?? el;
    return collapse(container.textContent ?? "").slice(0, 400);
  }

  function collectRootMarkers(): string[] {
    const markers: string[] = [];
    const seen = new Set<string>();
    const push = (marker: string): void => {
      if (!seen.has(marker)) {
        seen.add(marker);
        markers.push(marker);
      }
    };

    let node: ExtractElement | null = document.querySelector("form") ?? document.body;
    while (node && node.tagName !== "HTML") {
      const id = node.getAttribute("id");
      if (id) push("id=" + id);
      const dataSource = node.getAttribute("data-source");
      if (dataSource) push("data-source=" + dataSource);
      const cls = node.getAttribute("class");
      if (cls) push("class=" + cls);
      node = node.parentElement;
    }

    for (const el of Array.from(document.querySelectorAll("[class]"))) {
      const cls = el.getAttribute("class") ?? "";
      if (CAPTCHA_MARKER_RE.test(cls)) push("class=" + cls);
    }

    return markers;
  }

  const stepValues: string[] = [];
  for (const el of Array.from(document.querySelectorAll("[data-step]"))) {
    const value = el.getAttribute("data-step");
    if (value !== null && !stepValues.includes(value)) stepValues.push(value);
  }
  stepValues.sort((a, b) => Number(a) - Number(b));

  function stepIndexFor(el: ExtractElement): number {
    const stepEl = el.closest("[data-step]");
    if (!stepEl) return 0;
    const value = stepEl.getAttribute("data-step");
    if (value === null) return 0;
    const idx = stepValues.indexOf(value);
    return idx === -1 ? 0 : idx;
  }

  const fields: RawField[] = Array.from(document.querySelectorAll("input, textarea, select")).map((el) => {
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

    return {
      selector: buildSelector(el),
      tag,
      type,
      name: el.getAttribute("name") ?? "",
      id: el.getAttribute("id") ?? "",
      labelText: resolveLabelText(el),
      nearbyText: resolveNearbyText(el),
      placeholder: el.getAttribute("placeholder") ?? "",
      required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
      maxLength,
      accept: el.getAttribute("accept"),
      options,
      step: stepIndexFor(el),
    };
  });

  const buttons = Array.from(document.querySelectorAll("button")).map((el) => ({
    selector: buildSelector(el),
    id: el.getAttribute("id") ?? "",
    text: collapse(el.textContent ?? ""),
  }));

  return {
    title: collapse(document.querySelector("title")?.textContent ?? ""),
    bodyText: collapse(document.body?.textContent ?? "").slice(0, 20_000),
    rootMarkers: collectRootMarkers(),
    fields,
    buttons,
  };
}

/**
 * The step index of every <button>, in the same document order as
 * `ExtractedPage.buttons`. Kept separate because `RawFormPage.buttons` is a
 * frozen contract (selector/id/text) that the parsers share with the linkedom
 * helper — the driver needs the step to pick "the Next button of the step I am
 * on" from the page instead of hardcoding `#btn_next_1`.
 *
 * Self-contained for the same reason as `extractFromDocument`; see above.
 */
export function extractButtonStepsFromDocument(document: ExtractDocument): number[] {
  const stepValues: string[] = [];
  for (const el of Array.from(document.querySelectorAll("[data-step]"))) {
    const value = el.getAttribute("data-step");
    if (value !== null && !stepValues.includes(value)) stepValues.push(value);
  }
  stepValues.sort((a, b) => Number(a) - Number(b));

  return Array.from(document.querySelectorAll("button")).map((el) => {
    const stepEl = el.closest("[data-step]");
    const value = stepEl ? stepEl.getAttribute("data-step") : null;
    if (value === null) return 0;
    const idx = stepValues.indexOf(value);
    return idx === -1 ? 0 : idx;
  });
}

/** Source strings handed to `page.evaluate` — see the file header. */
export const EXTRACT_SCRIPT: string = `(${extractFromDocument.toString()})(document)`;
export const BUTTON_STEPS_SCRIPT: string = `(${extractButtonStepsFromDocument.toString()})(document)`;

/**
 * `RawFormPage.totalSteps` from the extracted fields: the highest 0-based step
 * seen, +1. Step assignment belongs to the driver (a page may reveal later
 * steps only after a "Next" click), and every field carries the step of the
 * section it was found in, so the count follows from the fields themselves.
 * A page with no [data-step] markers is a single step.
 */
export function deriveTotalSteps(fields: readonly RawField[]): number {
  let max = 0;
  for (const field of fields) {
    if (field.step > max) max = field.step;
  }
  return max + 1;
}
