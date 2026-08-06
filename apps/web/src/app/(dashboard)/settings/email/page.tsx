import { listEmailConnections } from "@careerhq/db";
import { loadConfig } from "@careerhq/config";
import { getDb } from "../../../../lib/db.js";
import { readWorkspaceSnapshot } from "../../../../lib/workspace.js";
import { EmptyState } from "../../../../components/empty-state.js";
import { Section } from "../../../../components/section.js";
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
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold text-ink">Email connections</h1>
        <p className="text-sm text-muted">
          Set <code>CAREERHQ_MASTER_KEY</code> to enable mailbox connections. Generate one with:
        </p>
        <pre className="inline-block w-fit rounded-md bg-canvas px-3 py-2 text-sm text-ink">
          {"node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""}
        </pre>
      </div>
    );
  }

  // One snapshot for the workspace and its connections (see
  // `readWorkspaceSnapshot`).
  const connections = await readWorkspaceSnapshot(getDb(), (tx, ws) => listEmailConnections(tx, ws.id));

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-2xl font-semibold text-ink">Email connections</h1>

      <Section title="Connections">
        {connections.length === 0 ? (
          <EmptyState title="No mailbox connections yet" />
        ) : (
          <ConnectionsTable connections={connections} now={Date.now()} />
        )}
      </Section>

      <Section title="Add connection">
        {config.demoMode ? (
          <EmptyState
            title="Credential setup is disabled in the hosted demo"
            hint="Sending is disabled and nothing leaves this server."
          />
        ) : (
          <ConnectionForm />
        )}
      </Section>
    </div>
  );
}
