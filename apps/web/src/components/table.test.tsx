// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Table, Td, Th } from "./table.js";

describe("Table", () => {
  it("renders as a real table so header/body semantics reach assistive tech", () => {
    render(
      <Table>
        <thead>
          <tr>
            <Th>Label</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td>Value</Td>
          </tr>
        </tbody>
      </Table>,
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Label" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Value" })).toBeInTheDocument();
  });

  it("scopes Th to its column so a screen reader knows which cells it governs", () => {
    render(
      <Table>
        <thead>
          <tr>
            <Th>Label</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td>Value</Td>
          </tr>
        </tbody>
      </Table>,
    );
    expect(screen.getByRole("columnheader", { name: "Label" })).toHaveAttribute("scope", "col");
  });

  it("Td's className is additive: the caller's class joins the base token classes rather than replacing them", () => {
    render(
      <Table>
        <tbody>
          <tr>
            <Td className="tabular-nums">Value</Td>
          </tr>
        </tbody>
      </Table>,
    );
    const cell = screen.getByRole("cell", { name: "Value" });
    expect(cell).toHaveClass("tabular-nums");
    // Base token classes must survive alongside the caller's class.
    expect(cell).toHaveClass("border-b", "border-line", "px-3", "py-2", "align-top", "text-sm", "text-ink");
  });
});
