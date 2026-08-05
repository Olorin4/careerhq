"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  imapConfigSchema, retentionSettingSchema,
  RETENTION_MODES, TLS_MODES,
  type ImapConfig, type RetentionMode, type RetentionSetting,
} from "@careerhq/contracts";
import type { EmailConnection } from "@careerhq/db";
import { timeAgo } from "../../../../lib/time.js";
import { createConnectionAction, disconnectAction, testConnectionAction } from "./actions.js";

// `imap`/`retention` are jsonb columns typed `unknown` at the schema level;
// every value stored there was written through the same contracts schemas
// the create form validates against, so re-parsing here is just a typed
// read, not a second round of user-facing validation.
function parseImap(value: unknown): ImapConfig | null {
  const parsed = imapConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
function parseRetention(value: unknown): RetentionSetting {
  const parsed = retentionSettingSchema.safeParse(value);
  return parsed.success ? parsed.data : { mode: "metadata_only" };
}

function healthBadgeClass(health: string): string {
  if (health === "ok") return "badge badge-ok";
  if (health === "error") return "badge badge-error";
  return "badge";
}

export function ConnectionsTable({ connections }: { connections: EmailConnection[] }) {
  return (
    <table className="email-connections-table">
      <thead>
        <tr>
          <th>Label</th>
          <th>From</th>
          <th>Health</th>
          <th>Last checked</th>
          <th>IMAP</th>
          <th>Retention</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {connections.map((connection) => (
          <ConnectionRow key={connection.id} connection={connection} />
        ))}
      </tbody>
    </table>
  );
}

function ConnectionRow({ connection }: { connection: EmailConnection }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [testResult, setTestResult] = useState<{ ok: boolean; reason?: string } | null>(null);

  const retention = parseRetention(connection.retention);
  const hasImap = parseImap(connection.imap) !== null;

  function handleTest() {
    setTestResult(null);
    startTransition(async () => {
      const result = await testConnectionAction({ connectionId: connection.id });
      setTestResult(result);
      router.refresh();
    });
  }

  function handleDisconnect() {
    if (typeof window !== "undefined" && !window.confirm(`Disconnect "${connection.label}"? This cannot be undone.`)) {
      return;
    }
    startTransition(async () => {
      const result = await disconnectAction({ connectionId: connection.id });
      // A refusal (the hosted demo, or an id that is not this workspace's) has
      // to be visible; a success removes the row on refresh and needs no message.
      setTestResult(result.ok ? null : result);
      router.refresh();
    });
  }

  return (
    <tr>
      <td>{connection.label}</td>
      <td>{connection.fromAddress}</td>
      <td>
        <span className={healthBadgeClass(connection.health)}>{connection.health}</span>
        {connection.healthDetail && <div className="email-health-detail">{connection.healthDetail}</div>}
      </td>
      <td>{connection.lastCheckedAt ? timeAgo(connection.lastCheckedAt) : "—"}</td>
      <td>{hasImap ? "Yes" : "No"}</td>
      <td>{retention.mode === "days_limited" ? `${retention.mode} (${retention.days}d)` : retention.mode}</td>
      <td className="email-connection-actions">
        <button type="button" onClick={handleTest} disabled={isPending}>Test</button>
        <button type="button" onClick={handleDisconnect} disabled={isPending}>Disconnect</button>
        {testResult && (
          <p className={testResult.ok ? "settings-form-success" : "settings-form-error"}>
            {testResult.ok ? "Connection OK" : testResult.reason}
          </p>
        )}
      </td>
    </tr>
  );
}

export function ConnectionForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [imapEnabled, setImapEnabled] = useState(false);
  const [retentionMode, setRetentionMode] = useState<RetentionMode>("metadata_only");
  const smtpPasswordRef = useRef<HTMLInputElement>(null);
  const imapPasswordRef = useRef<HTMLInputElement>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    const form = event.currentTarget;
    const formData = new FormData(form);

    startTransition(async () => {
      const result = await createConnectionAction(formData);
      if (result.ok) {
        form.reset();
        setImapEnabled(false);
        setRetentionMode("metadata_only");
        setSaved(true);
        router.refresh();
      } else {
        setError(result.reason);
        // Passwords are never echoed back on a validation/verify error.
        if (smtpPasswordRef.current) smtpPasswordRef.current.value = "";
        if (imapPasswordRef.current) imapPasswordRef.current.value = "";
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="settings-form">
      <label>
        Label
        <input name="label" type="text" required />
      </label>
      <label>
        From address
        <input name="fromAddress" type="email" required />
      </label>
      <label>
        Display name
        <input name="displayName" type="text" />
      </label>

      <fieldset className="email-form-fieldset">
        <legend>SMTP (send)</legend>
        <label>
          Host
          <input name="smtpHost" type="text" required />
        </label>
        <label>
          Port
          <input name="smtpPort" type="number" min={1} max={65535} defaultValue={587} required />
        </label>
        <label>
          Username
          <input name="smtpUsername" type="text" required />
        </label>
        <label>
          Password
          <input
            ref={smtpPasswordRef} name="smtpPassword" type="password"
            required autoComplete="new-password"
          />
        </label>
        <label>
          TLS
          <select name="smtpTls" defaultValue="starttls">
            {TLS_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
          </select>
        </label>
      </fieldset>

      <details className="email-form-fieldset" open={imapEnabled}>
        <summary>
          <span className="settings-form-checkbox email-imap-toggle">
            <input
              type="checkbox" name="imapEnabled"
              checked={imapEnabled}
              onChange={(event) => setImapEnabled(event.target.checked)}
            />
            Enable IMAP (optional)
          </span>
        </summary>
        <label>
          Host
          <input name="imapHost" type="text" disabled={!imapEnabled} />
        </label>
        <label>
          Port
          <input name="imapPort" type="number" min={1} max={65535} defaultValue={993} disabled={!imapEnabled} />
        </label>
        <label>
          Username
          <input name="imapUsername" type="text" disabled={!imapEnabled} />
        </label>
        <label>
          Password
          <input
            ref={imapPasswordRef} name="imapPassword" type="password"
            disabled={!imapEnabled} autoComplete="new-password"
          />
        </label>
        <label>
          TLS
          <select name="imapTls" defaultValue="implicit" disabled={!imapEnabled}>
            {TLS_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
          </select>
        </label>
        <label>
          Folders (comma-separated)
          <input name="imapFolders" type="text" placeholder="INBOX, Sent" disabled={!imapEnabled} />
        </label>
      </details>

      <label>
        Retention
        <select
          name="retentionMode" value={retentionMode}
          onChange={(event) => setRetentionMode(event.target.value as RetentionMode)}
        >
          {RETENTION_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
        </select>
      </label>
      {retentionMode === "days_limited" && (
        <label>
          Days to keep
          <input name="retentionDays" type="number" min={1} step={1} defaultValue={30} required />
        </label>
      )}

      <button type="submit" disabled={isPending}>Create connection</button>
      {saved && !error && <p className="settings-form-success">Connection created.</p>}
      {error && <p className="settings-form-error">{error}</p>}
    </form>
  );
}
