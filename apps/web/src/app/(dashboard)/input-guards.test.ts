import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEXT_LIMITS } from "@careerhq/contracts";

/**
 * The two guards every mutating dashboard action applies to what reaches it —
 * the demo rate limit, and a length cap on free text — and the property they
 * share: both refuse by RETURNING, never by throwing.
 *
 * The completeness proof for the demo rate limit across the four dashboard
 * action modules. Eleven mutating actions in `applications/`, `facts/`,
 * `inbox/` and `settings/` were unthrottled; the reason they were done as one
 * pass rather than piecemeal is that throttling one action but not its
 * neighbour in the same file advertises a guarantee the file does not have.
 * This suite is what keeps that true: every one of the eleven is named here,
 * with the bucket it spends.
 *
 * Two things are asserted for each, and they are the two that were actually at
 * risk:
 *
 *   1. The refusal is RETURNED, in the action's own failure shape. A thrown
 *      server-action failure reaches the visitor as Next's full-page
 *      "Application error" overlay — a bug this project has fixed twice.
 *      `resolves`, not `rejects`, is the whole point.
 *   2. It lands before `getDb()`. The action does no work it would have to
 *      undo, and the assertion does not need a database.
 *
 * The bucket is pre-spent through `checkRateLimit` directly rather than by
 * calling each action twice: the first call would otherwise have to run its
 * whole happy path, which is exactly the part this suite is asserting never
 * runs.
 */

const { loadConfigMock, getDbMock, getActiveWorkspaceMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  getDbMock: vi.fn(() => ({})),
  getActiveWorkspaceMock: vi.fn(async () => ({ id: "00000000-0000-4000-8000-0000000000ff", kind: "sandbox" })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@careerhq/config", () => ({ loadConfig: loadConfigMock }));
vi.mock("../../lib/db.js", () => ({ getDb: getDbMock }));
vi.mock("../../lib/workspace.js", () => ({ getActiveWorkspace: getActiveWorkspaceMock }));
vi.mock("@careerhq/db", () => ({
  createApplication: vi.fn(),
  getApplication: vi.fn(),
  hasApprovedMaterials: vi.fn(),
  setApplicationCvVariant: vi.fn(async () => ({ id: "x" })),
  transitionApplication: vi.fn(async () => ({ ok: true })),
  createFact: vi.fn(),
  reverifyFact: vi.fn(),
  archiveFact: vi.fn(),
  emailMessages: { id: "id" },
  setSuggestionState: vi.fn(),
  addWatchlistEntry: vi.fn(),
  removeWatchlistEntry: vi.fn(),
  saveScoringProfile: vi.fn(),
}));

const { createApplicationAction, selectCvAction, transitionApplicationAction } =
  await import("./applications/actions.js");
const { archiveFactAction, createFactAction, reverifyFactAction } = await import("./facts/actions.js");
const { acceptSuggestionAction, dismissSuggestionAction } = await import("./inbox/actions.js");
const {
  addWatchlistEntryAction, removeWatchlistEntryAction, saveScoringProfileAction,
} = await import("./settings/actions.js");
const { checkRateLimit, clearRateLimits } = await import("../../lib/rate-limit.js");

const APPLICATION_ID = "11111111-1111-4111-8111-111111111111";
const FACT_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const ENTRY_ID = "44444444-4444-4444-8444-444444444444";

const TOO_MANY = expect.stringMatching(/^too many requests, try again in \d+s$/) as unknown as string;

function form(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [name, value] of Object.entries(fields)) formData.append(name, value);
  return formData;
}

function scoringProfileForm(): FormData {
  return form({
    roles: "Backend engineer", stack: "TypeScript", boost: "", exclude: "",
    minRoleHits: "1", minStackHits: "1", topNForLlm: "25",
  });
}

/**
 * Every action this pass throttled, with the bucket it spends and the refusal
 * its own callers already know how to render. Adding a twelfth action to one
 * of these four files means adding a row here.
 */
const THROTTLED = [
  {
    bucket: "createApplication",
    call: () => createApplicationAction(null, form({ companyName: "Acme", jobTitle: "Engineer" })),
    expected: { reason: TOO_MANY, values: { companyName: "Acme", jobTitle: "Engineer" } },
  },
  {
    bucket: "transitionApplication",
    call: () => transitionApplicationAction({ applicationId: APPLICATION_ID, to: "SHORTLISTED" }),
    expected: { ok: false, reason: TOO_MANY },
  },
  {
    bucket: "selectCv",
    call: () => selectCvAction({ applicationId: APPLICATION_ID, cvVariantId: null }),
    expected: { ok: false, reason: TOO_MANY },
  },
  {
    bucket: "createFact",
    call: () => createFactAction(null, form({ category: "skill", claim: "Ships Rust", reviewBy: "2027-01-01" })),
    expected: {
      reason: TOO_MANY,
      values: { category: "skill", claim: "Ships Rust", reviewBy: "2027-01-01" },
    },
  },
  {
    bucket: "reverifyFact",
    call: () => reverifyFactAction(null, form({ id: FACT_ID, reviewBy: "2027-01-01" })),
    expected: { reason: TOO_MANY },
  },
  {
    bucket: "archiveFact",
    call: () => archiveFactAction(null, form({ id: FACT_ID })),
    expected: { reason: TOO_MANY },
  },
  {
    bucket: "acceptSuggestion",
    call: () => acceptSuggestionAction({ messageId: MESSAGE_ID }),
    expected: { ok: false, reason: TOO_MANY },
  },
  {
    bucket: "dismissSuggestion",
    call: () => dismissSuggestionAction({ messageId: MESSAGE_ID }),
    expected: { ok: false, reason: TOO_MANY },
  },
  {
    bucket: "saveScoringProfile",
    call: () => saveScoringProfileAction(scoringProfileForm()),
    expected: { ok: false, reason: TOO_MANY },
  },
  {
    bucket: "addWatchlistEntry",
    call: () => addWatchlistEntryAction({ companyName: "Acme", atsType: "greenhouse", boardSlug: "acme" }),
    expected: { ok: false, reason: TOO_MANY },
  },
  {
    bucket: "removeWatchlistEntry",
    call: () => removeWatchlistEntryAction(null, form({ id: ENTRY_ID })),
    expected: { reason: TOO_MANY },
  },
] as const;

describe("dashboard mutating actions past the demo budget", () => {
  beforeEach(() => {
    clearRateLimits();
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({ demoMode: true, demoRateLimitPerMin: 1 });
  });

  it("covers all eleven actions the pass throttled", () => {
    expect(THROTTLED).toHaveLength(11);
    expect(new Set(THROTTLED.map((entry) => entry.bucket)).size).toBe(11);
  });

  for (const { bucket, call, expected } of THROTTLED) {
    it(`${bucket} reports the refusal instead of throwing, before any database work`, async () => {
      checkRateLimit(bucket, { limit: 1 });

      await expect(call()).resolves.toEqual(expected);
      expect(getDbMock).not.toHaveBeenCalled();
    });
  }
});

describe("outside demo mode", () => {
  beforeEach(() => {
    clearRateLimits();
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({ demoMode: false, demoRateLimitPerMin: 1 });
  });

  /**
   * A personal, self-hosted install is one user on their own machine and is
   * never throttled — the budget can be fully spent and the action still runs.
   */
  it("spends nothing: an exhausted bucket still lets the action through", async () => {
    checkRateLimit("dismissSuggestion", { limit: 1 });

    await expect(dismissSuggestionAction({ messageId: MESSAGE_ID })).resolves.toEqual({ ok: true });
    expect(getDbMock).toHaveBeenCalled();
  });
});

/**
 * The free-text caps. Until `TEXT_LIMITS` existed these fields were bounded
 * only by Next's server-action body limit — 6 MB, and applied to every action,
 * so raising it for CV uploads loosened every `notes` box in the app by the
 * same factor.
 *
 * What is asserted is not the number (that lives in `TEXT_LIMITS`) but that
 * exceeding it is a MESSAGE. These schemas were `.parse`, not `.safeParse`, so
 * adding a `.max()` without also giving the rejection somewhere to render
 * would have turned a long paste into the full-page error overlay — trading
 * one unbounded input for one very visible crash.
 */
describe("free-text length caps", () => {
  beforeEach(() => {
    clearRateLimits();
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({ demoMode: false, demoRateLimitPerMin: 30 });
  });

  it("reports an over-long application note and keeps what was typed", async () => {
    const notes = "n".repeat(TEXT_LIMITS.detail + 1);
    const result = await createApplicationAction(
      null,
      form({ companyName: "Acme", jobTitle: "Engineer", notes }),
    );

    expect(result?.reason).toMatch(/^notes: /);
    expect(result?.values.notes).toBe(notes);
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("reports an over-long fact claim", async () => {
    const result = await createFactAction(
      null,
      form({ category: "skill", claim: "c".repeat(TEXT_LIMITS.headline + 1), reviewBy: "2027-01-01" }),
    );

    expect(result?.reason).toMatch(/^claim: /);
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("reports an over-long scoring-profile term by the line it came from", async () => {
    const profile = scoringProfileForm();
    profile.set("roles", `Backend engineer\n${"r".repeat(TEXT_LIMITS.term + 1)}`);

    await expect(saveScoringProfileAction(profile)).resolves.toEqual({
      ok: false,
      reason: expect.stringMatching(/^roles\.1: /) as unknown as string,
    });
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("accepts text right at the cap", async () => {
    const result = await createFactAction(
      null,
      form({ category: "skill", claim: "c".repeat(TEXT_LIMITS.headline), reviewBy: "2027-01-01" }),
    );

    expect(result).toBeNull();
    expect(getDbMock).toHaveBeenCalled();
  });
});
