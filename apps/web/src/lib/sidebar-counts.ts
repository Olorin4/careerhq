import { listApplications, listInboxJobs, listPendingSuggestions } from "@careerhq/db";
import type { SidebarCounts } from "../components/sidebar-constants.js";
import { getDb } from "./db.js";
import { DUE_SOON_WINDOW_MS } from "./time.js";
import { readWorkspaceSnapshot } from "./workspace.js";

/**
 * The three numbers the shell's rail shows beside its destinations (spec
 * §Shell: "live counts render beside the destinations where they mean
 * something: discovery inbox size, unread mail, due follow-ups"). Server-only
 * — `layout.tsx` is a Server Component and this is the read it does.
 *
 * Each count is deliberately the size of the list the destination it labels
 * actually renders, produced by the same repository call that page makes:
 * `discovery` is `/jobs`'s inbox (`listInboxJobs`), `mail` is `/inbox`'s
 * pending review queue (`listPendingSuggestions`), `due` is `/overview`'s
 * "Due soon" list (the same {@link DUE_SOON_WINDOW_MS} window). Counting the
 * rows a different way would eventually disagree with the page the badge
 * links to.
 *
 * One `readWorkspaceSnapshot`, for the reason every page uses one: the demo
 * reset is a DELETE+INSERT of the whole workspace, and three reads that
 * straddle its commit would show the shell a mixture of two generations (see
 * `workspace.ts`). Sequential rather than `Promise.all` — they share one
 * transaction, hence one connection.
 *
 * Never throws. A count is decoration on a navigation rail: if the database is
 * unreachable, the shell that wraps EVERY route — including the error and
 * not-found pages the visitor would be looking at — must still render. The
 * empty object is exactly what `Sidebar` already treats as "nothing to
 * report".
 */
export async function readSidebarCounts(): Promise<SidebarCounts> {
  const soon = Date.now() + DUE_SOON_WINDOW_MS;
  try {
    return await readWorkspaceSnapshot(getDb(), async (tx, ws) => {
      const inbox = await listInboxJobs(tx, ws.id);
      const pending = await listPendingSuggestions(tx, ws.id);
      const apps = await listApplications(tx, ws.id);
      return {
        discovery: inbox.length,
        mail: pending.length,
        due: apps.filter((a) => a.nextActionDue !== null && a.nextActionDue.getTime() <= soon).length,
      };
    });
  } catch {
    return {};
  }
}
