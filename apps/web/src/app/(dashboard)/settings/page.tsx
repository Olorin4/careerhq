import { getScoringProfile, listWatchlist, type WatchlistCompany } from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { getActiveWorkspace } from "../../../lib/workspace.js";
import { ProfileForm } from "./profile-form.js";
import { WatchlistForm } from "./watchlist-form.js";
import { removeWatchlistEntryAction } from "./actions.js";

// Every render reads the database, so there is nothing to prerender: without
// this Next would build these pages statically (baking in build-time data and
// requiring a reachable database at build time, which the container image has
// no reason to have).
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  const profile = await getScoringProfile(db, ws.id);
  const watchlist = await listWatchlist(db, ws.id);

  return (
    <main>
      <h1>Settings</h1>

      <section className="settings-section">
        <h2>Scoring profile</h2>
        <ProfileForm profile={profile} />
      </section>

      <section className="settings-section">
        <h2>ATS watchlist</h2>
        {watchlist.length === 0 ? (
          <p className="settings-empty">No companies on the watchlist yet.</p>
        ) : (
          <table className="watchlist-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>ATS</th>
                <th>Board slug</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {watchlist.map((entry) => (
                <WatchlistRow key={entry.id} entry={entry} />
              ))}
            </tbody>
          </table>
        )}
        <WatchlistForm />
      </section>
    </main>
  );
}

function WatchlistRow({ entry }: { entry: WatchlistCompany }) {
  return (
    <tr>
      <td>{entry.companyName}</td>
      <td>{entry.atsType}</td>
      <td>
        <code>{entry.boardSlug}</code>
      </td>
      <td>
        <form action={removeWatchlistEntryAction}>
          <input type="hidden" name="id" value={entry.id} />
          <button type="submit">Remove</button>
        </form>
      </td>
    </tr>
  );
}
