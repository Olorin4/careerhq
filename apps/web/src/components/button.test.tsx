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

  it("defaults to the unchanged size when no size prop is given", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button")).toHaveClass("px-3", "py-2", "text-sm");
  });

  it("renders smaller with size=\"compact\", for tight repeated layouts like the board", () => {
    render(<Button size="compact">Move</Button>);
    const button = screen.getByRole("button");
    expect(button).toHaveClass("px-2", "py-1", "text-xs");
    expect(button).not.toHaveClass("px-3", "py-2", "text-sm");
  });
});
