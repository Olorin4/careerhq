// In-memory submission store. This is the e2e assertion surface for
// auto-apply demos (Mailpit-style): tests POST an application then read it
// back via GET /api/submissions instead of scraping the confirmation page.
// Intentionally process-local and non-persistent — restarting the server
// clears it, same as re-running `docker compose up` clears Mailpit.

export interface StoredFile {
  filename: string;
  contentType: string;
  size: number;
}

export interface Submission {
  id: string;
  source: "greenhouse" | "lever";
  jobId: string;
  fields: Record<string, string>;
  files: StoredFile[];
  submittedAt: string;
}

const submissions: Submission[] = [];

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function addSubmission(
  source: Submission["source"],
  jobId: string,
  fields: Record<string, string>,
  files: StoredFile[],
): Submission {
  const submission: Submission = {
    id: `NR-${randomHex(4)}`,
    source,
    jobId,
    fields,
    files,
    submittedAt: new Date().toISOString(),
  };
  submissions.push(submission);
  return submission;
}

export function listSubmissions(): Submission[] {
  return submissions;
}

export function clearSubmissions(): void {
  submissions.length = 0;
}
