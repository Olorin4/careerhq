import { describe, it, expect } from "vitest";
import { formatDate, formatTimestamp, timeAgo } from "./time";

/**
 * These are the assertions behind the #418 fix. Vitest never hydrates, so a
 * green run here does NOT prove the page is clean — what it does prove is the
 * property the fix rests on: the output depends on neither the host locale nor
 * the host time zone, so the server and the browser cannot disagree.
 */
describe("formatTimestamp / formatDate", () => {
  const instant = new Date("2026-08-05T13:02:20.877Z");

  it("renders a stable, explicitly-UTC timestamp", () => {
    expect(formatTimestamp(instant)).toBe("2026-08-05 13:02 UTC");
  });

  it("accepts the ISO strings the server actions hand back, not just Date", () => {
    expect(formatTimestamp("2026-08-05T13:02:20.877Z")).toBe(formatTimestamp(instant));
  });

  it("renders the same text whatever the host time zone is", () => {
    const original = process.env.TZ;
    const rendered = new Set<string>();
    for (const tz of ["UTC", "Europe/Athens", "America/New_York", "Asia/Kolkata"]) {
      process.env.TZ = tz;
      rendered.add(formatTimestamp(instant));
      rendered.add(formatDate(instant));
    }
    process.env.TZ = original;
    // Two values — one timestamp, one date — and not one more.
    expect(rendered).toEqual(new Set(["2026-08-05 13:02 UTC", "2026-08-05"]));
  });

  it("renders a date-only value without a time", () => {
    expect(formatDate(instant)).toBe("2026-08-05");
  });
});

describe("timeAgo", () => {
  const baseTime = new Date("2025-08-02T12:00:00Z");

  it("shows 'just now' for times less than 60 seconds ago", () => {
    const within30s = new Date(baseTime.getTime() - 30_000);
    expect(timeAgo(within30s, baseTime)).toBe("just now");

    const within59s = new Date(baseTime.getTime() - 59_000);
    expect(timeAgo(within59s, baseTime)).toBe("just now");
  });

  it("shows minutes for times less than 60 minutes ago", () => {
    const within1m = new Date(baseTime.getTime() - 60_000);
    expect(timeAgo(within1m, baseTime)).toBe("1m ago");

    const within30m = new Date(baseTime.getTime() - 30 * 60_000);
    expect(timeAgo(within30m, baseTime)).toBe("30m ago");

    const within59m = new Date(baseTime.getTime() - 59 * 60_000);
    expect(timeAgo(within59m, baseTime)).toBe("59m ago");
  });

  it("shows hours for times less than 24 hours ago", () => {
    const within1h = new Date(baseTime.getTime() - 60 * 60_000);
    expect(timeAgo(within1h, baseTime)).toBe("1h ago");

    const within12h = new Date(baseTime.getTime() - 12 * 60 * 60_000);
    expect(timeAgo(within12h, baseTime)).toBe("12h ago");

    const within23h = new Date(baseTime.getTime() - 23 * 60 * 60_000);
    expect(timeAgo(within23h, baseTime)).toBe("23h ago");
  });

  it("shows days for times 24 hours or more ago", () => {
    const within1d = new Date(baseTime.getTime() - 24 * 60 * 60_000);
    expect(timeAgo(within1d, baseTime)).toBe("1d ago");

    const within7d = new Date(baseTime.getTime() - 7 * 24 * 60 * 60_000);
    expect(timeAgo(within7d, baseTime)).toBe("7d ago");

    const within30d = new Date(baseTime.getTime() - 30 * 24 * 60 * 60_000);
    expect(timeAgo(within30d, baseTime)).toBe("30d ago");
  });

  it("defaults to current time when now is not provided", () => {
    const recentTime = new Date();
    recentTime.setSeconds(recentTime.getSeconds() - 30);

    // Should not throw and should return "just now" for recent times
    expect(timeAgo(recentTime)).toBe("just now");
  });
});
