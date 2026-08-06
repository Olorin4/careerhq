// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge, type BadgeTone } from "./badge.js";

describe("Badge", () => {
  it.each<BadgeTone>(["info", "warn", "ok", "bad"])(
    "maps the %s tone to its soft background and matching text token",
    (tone) => {
      render(<Badge tone={tone}>Label</Badge>);
      const className = screen.getByText("Label").className;
      expect(className).toContain(`bg-${tone}-soft`);
      expect(className).toContain(`text-${tone}`);
    },
  );

  it("does not reuse a state tone's classes for the neutral tone", () => {
    render(<Badge tone="neutral">Label</Badge>);
    const className = screen.getByText("Label").className;
    expect(className).not.toMatch(/\b(info|warn|ok|bad)\b/);
  });

  it("forwards testId as a data-testid", () => {
    render(
      <Badge tone="ok" testId="status-badge">
        Verified
      </Badge>,
    );
    expect(screen.getByTestId("status-badge")).toBeInTheDocument();
  });
});
