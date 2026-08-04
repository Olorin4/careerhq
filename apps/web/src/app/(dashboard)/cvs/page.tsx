import { listCvVariants } from "@careerhq/db";
import { CV_FORMATS } from "@careerhq/contracts";
import { getDb } from "../../../lib/db.js";
import { getActiveWorkspace } from "../../../lib/workspace.js";
import { CvUploadForm } from "./cv-upload-form.js";

// Every render reads the database, so there is nothing to prerender: without
// this Next would build these pages statically (baking in build-time data and
// requiring a reachable database at build time, which the container image has
// no reason to have).
export const dynamic = "force-dynamic";

function humanize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

export default async function CvsPage() {
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  const variants = await listCvVariants(db, ws.id);

  return (
    <main>
      <h1>CV variants</h1>
      {/* `humanize` runs here, on the server: a "use client" module's exports
          are client references, so the form takes already-labelled options
          rather than importing the helper across the boundary. */}
      <CvUploadForm formats={CV_FORMATS.map((format) => ({ value: format, label: humanize(format) }))} />

      {variants.length === 0 ? (
        <p className="cv-empty">No CV variants uploaded yet.</p>
      ) : (
        <table className="cv-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Format</th>
              <th>SHA-256</th>
              <th>Uploaded</th>
            </tr>
          </thead>
          <tbody>
            {variants.map((variant) => (
              <tr key={variant.id}>
                <td>{variant.label}</td>
                <td>{humanize(variant.format)}</td>
                <td>
                  <code>{variant.sha256.slice(0, 12)}</code>
                </td>
                <td>{variant.createdAt.toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
