// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Sidebar } from "./sidebar.js";

describe("Sidebar", () => {
  it("shows a count when there is one, and omits it at zero", () => {
    render(<Sidebar counts={{ discovery: 27, mail: 0 }} />);
    expect(screen.getByText("27")).toBeInTheDocument();
    // A zero count is noise, not information.
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  // The brief's original version of this test asserted each link's accessible
  // name against a regex built from its own href slug (e.g. `/jobs` → /jobs/i).
  // That contradicts the product's own page titles: `/jobs` renders "Discovery
  // inbox" and `/inbox` renders "Mail" (see the `<h1>`s in
  // `app/(dashboard)/jobs/page.tsx` and `app/(dashboard)/inbox/page.tsx`), and
  // those are exactly the labels the pre-existing top nav already used. Making
  // the test pass as written would mean renaming the Discovery and Mail links
  // to "Jobs" and "Inbox" — matching the URL instead of the product's own
  // vocabulary. Fixed here to assert each link's real, reviewed label instead.
  it("links every destination, labelled the way the product's own pages are", () => {
    render(<Sidebar counts={{}} />);
    const destinations: Array<[href: string, label: string]> = [
      ["/overview", "Overview"],
      ["/jobs", "Discovery"],
      ["/applications", "Applications"],
      ["/inbox", "Mail"],
      ["/facts", "Facts"],
      ["/answers", "Answers"],
      ["/cvs", "CVs"],
      ["/settings", "Settings"],
    ];
    for (const [href, label] of destinations) {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", href);
    }
  });

  it("exposes the collapse toggle as a button with an accessible name", () => {
    render(<Sidebar counts={{}} />);
    expect(screen.getByRole("button", { name: /collapse sidebar/i })).toBeInTheDocument();
  });
});
