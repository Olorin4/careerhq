// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Countdown } from "./countdown.js";

describe("Countdown", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("counts down and reaches expired", () => {
    const expiresAt = new Date(Date.now() + 62_000).toISOString();
    render(<Countdown expiresAt={expiresAt} />);
    expect(screen.getByText("1:02")).toBeInTheDocument();
    // The interval callback fires outside any React-managed event, so its
    // `setState` needs an explicit `act()` to flush synchronously — without
    // it the update lands in the fiber tree but this assertion runs before
    // the DOM reflects it.
    act(() => {
      vi.advanceTimersByTime(63_000);
    });
    expect(screen.getByText(/expired/i)).toBeInTheDocument();
  });
});
