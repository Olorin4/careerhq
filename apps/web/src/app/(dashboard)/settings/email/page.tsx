import { listEmailConnections } from "@careerhq/db";
import { loadConfig } from "@careerhq/config";
import { getDb } from "../../../../lib/db.js";
import { getActiveWorkspace } from "../../../../lib/workspace.js";
import { ConnectionForm, ConnectionsTable } from "./connection-form.js";

// Every render reads the database, so there is nothing to prerender: without
// this Next would build these pages statically (baking in build-time data and
// requiring a reachable database at build time, which the container image has
// no reason to have).
export const dynamic = "force-dynamic";

export default async function EmailSettingsPage() {
  const config = loadConfig();
  const masterKey = config.masterKey;

  if (!masterKey) {
    return (
      <main>
        <h1>Email connections</h1>
        <p className="settings-empty">
          Set <code>CAREERHQ_MASTER_KEY</code> to enable mailbox connections. Generate one with:
        </p>
        <pre className="email-keygen-command">
          {"node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""}
        </pre>
      </main>
    );
  }

  const db = getDb();
  const ws = await getActiveWorkspace(db);
  const connections = await listEmailConnections(db, ws.id);

  return (
    <main>
      <h1>Email connections</h1>

      <section className="settings-section">
        <h2>Connections</h2>
        {connections.length === 0 ? (
          <p className="settings-empty">No mailbox connections yet.</p>
        ) : (
          <ConnectionsTable connections={connections} />
        )}
      </section>

      <section className="settings-section">
        <h2>Add connection</h2>
        {config.demoMode ? (
          <p className="settings-empty email-demo-disabled">
            Credential setup is disabled in the hosted demo — sending is disabled and nothing leaves this server.
          </p>
        ) : (
          <ConnectionForm />
        )}
      </section>
    </main>
  );
}
