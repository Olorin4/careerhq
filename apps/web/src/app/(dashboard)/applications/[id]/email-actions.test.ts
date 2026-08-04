import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@careerhq/config";

/**
 * The ordering proof for the demo rate limiter (spec P6 §3): a refusal has to
 * land BEFORE anything irreversible. On the email channel everything
 * irreversible — burning the confirmation token, `beginSubmission`, opening
 * the SMTP credential, the send itself — lives inside `confirmAndSend`, so
 * "the orchestrator was never entered" is exactly the guarantee to assert.
 * Every dependency the action would otherwise reach is mocked, which is also
 * why this suite needs no database.
 */
const { loadConfigMock, confirmAndSendMock, getDbMock, getActiveWorkspaceMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  confirmAndSendMock: vi.fn(),
  getDbMock: vi.fn(() => ({})),
  getActiveWorkspaceMock: vi.fn(async () => ({ id: "00000000-0000-4000-8000-0000000000ff", kind: "sandbox" })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@careerhq/config", () => ({ loadConfig: loadConfigMock }));
vi.mock("../../../../lib/db.js", () => ({ getDb: getDbMock }));
vi.mock("../../../../lib/workspace.js", () => ({ getActiveWorkspace: getActiveWorkspaceMock }));
vi.mock("../../../../lib/email-submission.js", () => ({
  confirmAndSend: confirmAndSendMock,
  previewSubmission: vi.fn(),
}));

const { confirmAndSendAction } = await import("./email-actions.js");
const { clearRateLimits } = await import("../../../../lib/rate-limit.js");

function setConfig(overrides: Partial<AppConfig>): void {
  loadConfigMock.mockReturnValue({ demoMode: false, demoRateLimitPerMin: 30, ...overrides });
}

const ARGS = {
  applicationId: "11111111-1111-4111-8111-111111111111",
  attemptId: "22222222-2222-4222-8222-222222222222",
  presentedToken: "token-abc",
  retypedTarget: "jobs@acme.test",
};

describe("confirmAndSendAction rate limiting", () => {
  beforeEach(() => {
    clearRateLimits();
    vi.clearAllMocks();
    confirmAndSendMock.mockResolvedValue({ status: "submitted", messageId: "m1" });
  });

  it("refuses past the demo budget before the orchestrator can burn a token", async () => {
    setConfig({ demoMode: true, demoRateLimitPerMin: 1 });

    await expect(confirmAndSendAction(ARGS)).resolves.toEqual({ status: "submitted", messageId: "m1" });
    expect(confirmAndSendMock).toHaveBeenCalledTimes(1);

    const refused = await confirmAndSendAction(ARGS);
    expect(refused).toEqual({
      status: "blocked",
      code: "rate_limited",
      reason: expect.stringMatching(/too many requests, try again in \d+s/) as unknown as string,
    });
    // The whole point: no second call means no token redemption, no
    // beginSubmission, no transport — the attempt is untouched and retryable.
    expect(confirmAndSendMock).toHaveBeenCalledTimes(1);
    // And the refusal happens before the action even resolves a workspace.
    expect(getActiveWorkspaceMock).toHaveBeenCalledTimes(1);
  });

  it("never throttles outside demo mode", async () => {
    setConfig({ demoMode: false, demoRateLimitPerMin: 1 });

    for (let i = 0; i < 5; i += 1) {
      await expect(confirmAndSendAction(ARGS)).resolves.toEqual({ status: "submitted", messageId: "m1" });
    }
    expect(confirmAndSendMock).toHaveBeenCalledTimes(5);
  });
});
