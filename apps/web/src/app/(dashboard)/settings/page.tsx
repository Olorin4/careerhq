import { getScoringProfile, listWatchlist, type WatchlistCompany } from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { readWorkspaceSnapshot } from "../../../lib/workspace.js";
import { EmptyState } from "../../../components/empty-state.js";
import { Section } from "../../../components/section.js";
import { Table, Td, Th } from "../../../components/table.js";
import { ProfileForm } from "./profile-form.js";
import { WatchlistForm } from "./watchlist-form.js";
import { WatchlistRemoveForm } from "./watchlist-remove-form.js";

// Every render reads the database, so there is nothing to prerender: without
// this Next would build these pages statically (baking in build-time data and
// requiring a reachable database at build time, which the container image has
// no reason to have).
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  // One snapshot: the profile and the watchlist shown together belong to the
  // same workspace generation (see `readWorkspaceSnapshot`).
  const { profile, watchlist } = await readWorkspaceSnapshot(getDb(), async (tx, ws) => ({
    profile: await getScoringProfile(tx, ws.id),
    watchlist: await listWatchlist(tx, ws.id),
  }));

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-2xl font-semibold text-ink">Settings</h1>

      <Section title="Scoring profile">
        <ProfileForm profile={profile} />
      </Section>

      <Section title="ATS watchlist">
        {watchlist.length === 0 ? (
          <EmptyState title="No companies on the watchlist yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Company</Th>
                <Th>ATS</Th>
                <Th>Board slug</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {watchlist.map((entry) => (
                <WatchlistRow key={entry.id} entry={entry} />
              ))}
            </tbody>
          </Table>
        )}
        <WatchlistForm />
      </Section>

      <Section title="Email connections">
        <p className="text-sm text-ink">
          Connect a mailbox to send applications and track replies.{" "}
          <a href="/settings/email" className="text-ink underline">
            Manage email connections
          </a>
        </p>
      </Section>
    </div>
  );
}

function WatchlistRow({ entry }: { entry: WatchlistCompany }) {
  return (
    <tr>
      <Td>{entry.companyName}</Td>
      <Td>{entry.atsType}</Td>
      <Td>
        <code>{entry.boardSlug}</code>
      </Td>
      <Td>
        <WatchlistRemoveForm entryId={entry.id} />
      </Td>
    </tr>
  );
}
