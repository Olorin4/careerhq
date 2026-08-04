import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  captchaPage,
  confirmationPage,
  greenhousePage,
  indexPage,
  leverPage,
  loginPage,
  signaturePage,
  type DemoJob,
} from "./pages.js";
import { addSubmission, clearSubmissions, listSubmissions, type StoredFile } from "./store.js";

const COMPANY = "Northwind Robotics";

const JOBS: DemoJob[] = [
  { id: "eng-1", title: "Senior Robotics Engineer", company: COMPANY },
  { id: "eng-2", title: "Autonomy Software Engineer", company: COMPANY },
];

function jobFor(id: string): DemoJob {
  return JOBS.find((job) => job.id === id) ?? { id, title: "Open Position", company: COMPANY };
}

const app = new Hono();

app.get("/", (c) => c.html(indexPage(JOBS)));

app.get("/greenhouse/jobs/:id", (c) => c.html(greenhousePage(jobFor(c.req.param("id")))));
app.get("/lever/jobs/:id", (c) => c.html(leverPage(jobFor(c.req.param("id")))));
app.get("/captcha/jobs/:id", (c) => c.html(captchaPage(jobFor(c.req.param("id")))));
app.get("/login/jobs/:id", (c) => c.html(loginPage(jobFor(c.req.param("id")))));
app.get("/signature/jobs/:id", (c) => c.html(signaturePage(jobFor(c.req.param("id")))));

async function handleApply(source: "greenhouse" | "lever", jobId: string, body: unknown) {
  const fields: Record<string, string> = {};
  const files: StoredFile[] = [];
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (entry instanceof File) {
        files.push({ filename: entry.name, contentType: entry.type, size: entry.size });
      } else if (typeof entry === "string") {
        fields[key] = entry;
      }
    }
  }
  return addSubmission(source, jobId, fields, files);
}

app.post("/greenhouse/apply/:id", async (c) => {
  const body = await c.req.parseBody({ all: true });
  const submission = await handleApply("greenhouse", c.req.param("id"), body);
  return c.html(confirmationPage(submission.id));
});

app.post("/lever/apply/:id", async (c) => {
  const body = await c.req.parseBody({ all: true });
  const submission = await handleApply("lever", c.req.param("id"), body);
  return c.html(confirmationPage(submission.id));
});

app.post("/signature/apply/:id", async (c) => {
  const body = await c.req.parseBody({ all: true });
  const submission = await handleApply("lever", c.req.param("id"), body);
  return c.html(confirmationPage(submission.id));
});

app.get("/api/submissions", (c) => c.json(listSubmissions()));
app.delete("/api/submissions", (c) => {
  clearSubmissions();
  return c.json({ cleared: true });
});

const port = Number(process.env["PORT"] ?? 3001);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[demo-ats] Northwind Robotics ATS listening on http://localhost:${info.port}`);
});
