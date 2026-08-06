"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  imapConfigSchema, retentionSettingSchema,
  RETENTION_MODES, TLS_MODES,
  type ImapConfig, type RetentionMode, type RetentionSetting,
} from "@careerhq/contracts";
import type { EmailConnection } from "@careerhq/db";
import { Badge, type BadgeTone } from "../../../../components/badge.js";
import { Button } from "../../../../components/button.js";
import { Card } from "../../../../components/card.js";
import { CONTROL_CLASSES, Field } from "../../../../components/field.js";
import { Table, Td, Th } from "../../../../components/table.js";
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

/** `ok`/`error` map straight onto `ok`/`bad`; anything else (unchecked) is `neutral`. */
function healthTone(health: string): BadgeTone {
  if (health === "ok") return "ok";
  if (health === "error") return "bad";
  return "neutral";
}

/**
 * `now` is a prop, not a `Date.now()` call in here, and that is load-bearing:
 * this module is `"use client"` but it is rendered from a server page, so React
 * renders this table once in the Node process and again in the browser when it
 * hydrates. A `now` computed inside would be a different instant each time, and
 * a "last checked" that crossed a bucket edge in between would render "1h ago"
 * in the HTML and "2h ago" after hydration — a mismatch. Passed down, the two
 * renders are given the same number and cannot disagree. `router.refresh()`
 * after a test or a disconnect re-renders on the server and brings a fresh one.
 */
export function ConnectionsTable(
  { connections, now }: { connections: EmailConnection[]; now: number },
) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Label</Th>
          <Th>From</Th>
          <Th>Health</Th>
          <Th>Last checked</Th>
          <Th>IMAP</Th>
          <Th>Retention</Th>
          <Th />
        </tr>
      </thead>
      <tbody>
        {connections.map((connection) => (
          <ConnectionRow key={connection.id} connection={connection} now={now} />
        ))}
      </tbody>
    </Table>
  );
}

function ConnectionRow({ connection, now }: { connection: EmailConnection; now: number }) {
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

  // The copy is deliberately not "this cannot be undone", which is what it used
  // to say while the control below stays `default`-toned. `--irreversible` is
  // reserved for controls that touch the outside world, and disconnecting
  // notifies nobody: it deletes this workspace's own stored credentials and
  // nothing else, and re-entering them restores the connection. Softening the
  // sentence is the fix rather than escalating the tone — a confirm that
  // overstates the stakes teaches the user to distrust the ones that don't.
  function handleDisconnect() {
    const question = `Disconnect "${connection.label}"? Its stored credentials are deleted — you can reconnect by entering them again.`;
    if (typeof window !== "undefined" && !window.confirm(question)) {
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
      <Td>{connection.label}</Td>
      <Td>{connection.fromAddress}</Td>
      <Td>
        <Badge tone={healthTone(connection.health)}>{connection.health}</Badge>
        {connection.healthDetail && (
          <div className="mt-1 max-w-xs text-xs text-bad">{connection.healthDetail}</div>
        )}
      </Td>
      <Td>{connection.lastCheckedAt ? timeAgo(connection.lastCheckedAt, now) : "—"}</Td>
      <Td>{hasImap ? "Yes" : "No"}</Td>
      <Td>{retention.mode === "days_limited" ? `${retention.mode} (${retention.days}d)` : retention.mode}</Td>
      <Td>
        <div className="flex flex-col items-start gap-1">
          <div className="flex gap-2">
            <Button type="button" tone="default" onClick={handleTest} disabled={isPending}>Test</Button>
            <Button type="button" tone="default" onClick={handleDisconnect} disabled={isPending}>Disconnect</Button>
          </div>
          {testResult && (
            <p className={`m-0 text-xs ${testResult.ok ? "text-ok" : "text-bad"}`}>
              {testResult.ok ? "Connection OK" : testResult.reason}
            </p>
          )}
        </div>
      </Td>
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
    <Card className="max-w-lg">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <Field label="Label">
          <input name="label" type="text" required className={CONTROL_CLASSES} />
        </Field>
        <Field label="From address">
          <input name="fromAddress" type="email" required className={CONTROL_CLASSES} />
        </Field>
        <Field label="Display name">
          <input name="displayName" type="text" className={CONTROL_CLASSES} />
        </Field>

        <fieldset className="flex flex-col gap-3 rounded-md border border-line p-3">
          <legend className="px-1 text-sm font-medium text-ink">SMTP (send)</legend>
          <Field label="Host">
            <input name="smtpHost" type="text" required className={CONTROL_CLASSES} />
          </Field>
          <Field label="Port">
            <input name="smtpPort" type="number" min={1} max={65535} defaultValue={587} required className={CONTROL_CLASSES} />
          </Field>
          <Field label="Username">
            <input name="smtpUsername" type="text" required className={CONTROL_CLASSES} />
          </Field>
          <Field label="Password">
            <input
              ref={smtpPasswordRef} name="smtpPassword" type="password"
              required autoComplete="new-password" className={CONTROL_CLASSES}
            />
          </Field>
          <Field label="TLS">
            <select name="smtpTls" defaultValue="starttls" className={CONTROL_CLASSES}>
              {TLS_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
            </select>
          </Field>
        </fieldset>

        <details className="flex flex-col gap-3 rounded-md border border-line p-3" open={imapEnabled}>
          <summary className="cursor-pointer list-none">
            <label className="inline-flex items-center gap-2 text-sm font-semibold text-ink">
              <input
                type="checkbox" name="imapEnabled"
                checked={imapEnabled}
                onChange={(event) => setImapEnabled(event.target.checked)}
              />
              Enable IMAP (optional)
            </label>
          </summary>
          <Field label="Host">
            <input name="imapHost" type="text" disabled={!imapEnabled} className={CONTROL_CLASSES} />
          </Field>
          <Field label="Port">
            <input
              name="imapPort" type="number" min={1} max={65535} defaultValue={993} disabled={!imapEnabled}
              className={CONTROL_CLASSES}
            />
          </Field>
          <Field label="Username">
            <input name="imapUsername" type="text" disabled={!imapEnabled} className={CONTROL_CLASSES} />
          </Field>
          <Field label="Password">
            <input
              ref={imapPasswordRef} name="imapPassword" type="password"
              disabled={!imapEnabled} autoComplete="new-password" className={CONTROL_CLASSES}
            />
          </Field>
          <Field label="TLS">
            <select name="imapTls" defaultValue="implicit" disabled={!imapEnabled} className={CONTROL_CLASSES}>
              {TLS_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
            </select>
          </Field>
          <Field label="Folders (comma-separated)">
            <input
              name="imapFolders" type="text" placeholder="INBOX, Sent" disabled={!imapEnabled}
              className={CONTROL_CLASSES}
            />
          </Field>
        </details>

        <Field label="Retention">
          <select
            name="retentionMode" value={retentionMode}
            onChange={(event) => setRetentionMode(event.target.value as RetentionMode)}
            className={CONTROL_CLASSES}
          >
            {RETENTION_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
          </select>
        </Field>
        {retentionMode === "days_limited" && (
          <Field label="Days to keep">
            <input name="retentionDays" type="number" min={1} step={1} defaultValue={30} required className={CONTROL_CLASSES} />
          </Field>
        )}

        <Button type="submit" tone="primary" disabled={isPending} className="self-start">
          Create connection
        </Button>
        {saved && !error && <p className="m-0 text-sm text-ok">Connection created.</p>}
        {error && (
          <p className="m-0 text-sm text-bad" role="alert">
            {error}
          </p>
        )}
      </form>
    </Card>
  );
}
