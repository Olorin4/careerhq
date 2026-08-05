import { readdir } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@careerhq/config";

/**
 * The ordering proof for the demo throttle on the one action that writes a
 * visitor's bytes to the host's disk (P6 task-3 review advisory B / fixwave
 * A5). The thing to assert is not just "it returned a reason" but "nothing
 * reached the disk and nothing reached the database" — a refusal that still
 * writes 5 MB has not protected the box from anything.
 *
 * `fileStorageDir` is a real temp directory rather than a mock so the store
 * ceiling is measured against real bytes; only the database is mocked.
 */
const fileStorageDir = mkdtempSync(path.join(tmpdir(), "careerhq-cv-action-"));
const cvDir = path.join(fileStorageDir, "cvs");

const { loadConfigMock, createCvVariantMock, listCvFilePathsMock, getActiveWorkspaceMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  createCvVariantMock: vi.fn(async () => ({ id: "cv-1" })),
  listCvFilePathsMock: vi.fn(async () => [] as string[]),
  getActiveWorkspaceMock: vi.fn(async () => ({ id: "00000000-0000-4000-8000-0000000000ff", kind: "sandbox" })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@careerhq/config", () => ({ loadConfig: loadConfigMock }));
vi.mock("@careerhq/db", () => ({
  createCvVariant: createCvVariantMock,
  listCvFilePaths: listCvFilePathsMock,
}));
vi.mock("../../../lib/db.js", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../../lib/workspace.js", () => ({ getActiveWorkspace: getActiveWorkspaceMock }));

const { uploadCvAction } = await import("./actions.js");
const { clearRateLimits } = await import("../../../lib/rate-limit.js");
const { DEMO_MAX_CV_BYTES, MAX_CV_BYTES } = await import("../../../lib/cv-storage.js");

afterAll(() => rmSync(fileStorageDir, { recursive: true, force: true }));

function setConfig(overrides: Partial<AppConfig>): void {
  loadConfigMock.mockReturnValue({ demoMode: false, demoRateLimitPerMin: 30, fileStorageDir, ...overrides });
}

function upload(bytes = 1024, label = "Principal CV"): FormData {
  const formData = new FormData();
  formData.set("label", label);
  formData.set("format", "ats");
  formData.set("file", new File([new Uint8Array(bytes)], "cv.pdf", { type: "application/pdf" }));
  return formData;
}

async function storedFiles(): Promise<string[]> {
  return readdir(cvDir).catch(() => []);
}

describe("uploadCvAction rate limiting", () => {
  beforeEach(async () => {
    clearRateLimits();
    vi.clearAllMocks();
    createCvVariantMock.mockResolvedValue({ id: "cv-1" });
    listCvFilePathsMock.mockResolvedValue([]);
    rmSync(cvDir, { recursive: true, force: true });
  });

  it("refuses past the demo budget, before anything is written or recorded", async () => {
    setConfig({ demoMode: true, demoRateLimitPerMin: 1 });

    await expect(uploadCvAction(null, upload())).resolves.toBeNull();
    expect(createCvVariantMock).toHaveBeenCalledTimes(1);
    expect(await storedFiles()).toHaveLength(1);

    const refused = await uploadCvAction(null, upload());
    expect(refused).toEqual({
      reason: expect.stringMatching(/too many requests, try again in \d+s/) as unknown as string,
      label: "Principal CV",
    });
    // The whole point: the second 1 KB never reached the disk and no row was
    // written, and the refusal came back as a value rather than a thrown 500.
    expect(createCvVariantMock).toHaveBeenCalledTimes(1);
    expect(await storedFiles()).toHaveLength(1);
  });

  it("shares one budget with the other heavy buckets' rate, not the click-y default", async () => {
    setConfig({ demoMode: true, demoRateLimitPerMin: 30 });

    for (let i = 0; i < 5; i += 1) {
      await expect(uploadCvAction(null, upload())).resolves.toBeNull();
    }
    expect(await uploadCvAction(null, upload())).toMatchObject({
      reason: expect.stringMatching(/too many requests/) as unknown as string,
    });
    expect(createCvVariantMock).toHaveBeenCalledTimes(5);
  });

  it("never throttles outside demo mode — a personal install uploads as often as it likes", async () => {
    setConfig({ demoMode: false, demoRateLimitPerMin: 1 });

    for (let i = 0; i < 8; i += 1) {
      await expect(uploadCvAction(null, upload())).resolves.toBeNull();
    }
    expect(createCvVariantMock).toHaveBeenCalledTimes(8);
    expect(await storedFiles()).toHaveLength(8);
    // And it does not even ask the database which files are live: the prune
    // and the store ceiling are demo-only.
    expect(listCvFilePathsMock).not.toHaveBeenCalled();
  });
});

describe("uploadCvAction size bounds", () => {
  beforeEach(() => {
    clearRateLimits();
    vi.clearAllMocks();
    createCvVariantMock.mockResolvedValue({ id: "cv-1" });
    listCvFilePathsMock.mockResolvedValue([]);
    rmSync(cvDir, { recursive: true, force: true });
  });

  it("refuses a file over the demo per-file cap without writing it", async () => {
    setConfig({ demoMode: true, demoRateLimitPerMin: 30 });

    const refused = await uploadCvAction(null, upload(DEMO_MAX_CV_BYTES + 1));
    expect(refused).toMatchObject({ reason: expect.stringMatching(/accepts PDFs up to 2 MB/) as unknown as string });
    expect(createCvVariantMock).not.toHaveBeenCalled();
    expect(await storedFiles()).toHaveLength(0);
  });

  it("accepts that same file outside demo mode, where only the 5 MB cap applies", async () => {
    setConfig({ demoMode: false });

    await expect(uploadCvAction(null, upload(DEMO_MAX_CV_BYTES + 1))).resolves.toBeNull();
    expect(await storedFiles()).toHaveLength(1);

    const tooBig = await uploadCvAction(null, upload(MAX_CV_BYTES + 1));
    expect(tooBig).toMatchObject({ reason: expect.stringMatching(/exceeds the 5 MB limit/) as unknown as string });
    expect(await storedFiles()).toHaveLength(1);
  });

  it("reports a non-PDF and a blank label as values, never as a throw", async () => {
    setConfig({ demoMode: true, demoRateLimitPerMin: 30 });

    const noLabel = new FormData();
    noLabel.set("label", "   ");
    noLabel.set("format", "ats");
    noLabel.set("file", new File([new Uint8Array(8)], "cv.pdf", { type: "application/pdf" }));
    await expect(uploadCvAction(null, noLabel)).resolves.toMatchObject({ reason: expect.stringContaining("label") as unknown as string });

    const notPdf = new FormData();
    notPdf.set("label", "CV");
    notPdf.set("format", "ats");
    notPdf.set("file", new File([new Uint8Array(8)], "cv.txt", { type: "text/plain" }));
    await expect(uploadCvAction(null, notPdf)).resolves.toEqual({ reason: "a PDF file is required", label: "CV" });

    expect(createCvVariantMock).not.toHaveBeenCalled();
  });
});
