import type { AppConfig } from "@careerhq/config";
import { seedDemoWorkspace, type Db } from "@careerhq/db";

/**
 * Wipes and reseeds the hosted demo's workspace (spec P6 §3), so a visitor's
 * edits never accumulate and every visitor gets the same story.
 *
 * The destructive part lives entirely in `seedDemoWorkspace`, which is scoped
 * to `kind = "sandbox" AND name = DEMO_WORKSPACE_NAME` — this job adds no
 * deletion of its own, and deliberately does not resolve "the active
 * workspace": a misconfigured `DEMO_MODE` on a personal deployment would then
 * point this at real data. `main.ts` registers the schedule only when
 * `config.demoMode`, which is the second half of the same guarantee.
 *
 * The mailbox is seeded only when a master key is configured: its SMTP password
 * goes through the normal libsodium seal path, and an unopenable credential
 * would be worse than no mailbox at all.
 */
export async function runDemoResetOnce(
  db: Db,
  config: AppConfig,
): Promise<{ workspaceId: string; durationMs: number }> {
  const startedAt = Date.now();
  const { workspaceId } = await seedDemoWorkspace(db, {
    fileStorageDir: config.fileStorageDir,
    masterKeyB64: config.masterKey,
    sandboxSmtpHost: config.sandboxSmtpAllowedHost,
    demoAtsUrl: config.demoAtsUrl,
  });
  return { workspaceId, durationMs: Date.now() - startedAt };
}
