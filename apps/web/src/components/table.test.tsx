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
});
