"use client";

import { useState } from "react";
import { createApplicationAction } from "./actions.js";

export function NewApplicationForm() {
  const [external, setExternal] = useState(false);

  return (
    <form action={createApplicationAction} className="new-application-form">
      <h2>Log application</h2>
      <label>
        Company
        <input name="companyName" type="text" required />
      </label>
      <label>
        Job title
        <input name="jobTitle" type="text" required />
      </label>
      <label>
        Job URL
        <input name="jobUrl" type="url" />
      </label>
      <label>
        Notes
        <textarea name="notes" />
      </label>
      <label className="new-application-form-checkbox">
        <input
          name="external"
          type="checkbox"
          checked={external}
          onChange={(e) => setExternal(e.target.checked)}
        />
        Already applied elsewhere
      </label>
      {external && (
        <label>
          Submitted on
          <input name="submittedAt" type="date" required />
        </label>
      )}
      <button type="submit">Log application</button>
    </form>
  );
}
