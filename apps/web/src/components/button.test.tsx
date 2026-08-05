// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button.js";

describe("Button", () => {
  it("marks an irreversible action distinctly from a primary one", () => {
    const { rerender } = render(<Button tone="primary">Save</Button>);
    const primary = screen.getByRole("button").className;
    rerender(<Button tone="irreversible">Confirm and submit</Button>);
    const irreversible = screen.getByRole("button").className;
    // The whole point: these must not look the same.
    expect(irreversible).not.toBe(primary);
    expect(irreversible).toContain("irreversible");
  });

  it("stays a real button for keyboard users", () => {
    render(<Button tone="irreversible">Confirm</Button>);
    expect(screen.getByRole("button")).toBeEnabled();
  });
});
