import type { EmailMessage } from "@careerhq/db";
import { Badge } from "../../../../components/badge.js";
import { EmptyState } from "../../../../components/empty-state.js";
import { Section } from "../../../../components/section.js";
import { formatTimestamp } from "../../../../lib/time.js";

function humanize(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");
}

/**
 * The application's email thread, oldest first, both directions. A pure
 * server fragment — nothing here is interactive, so it renders straight from
 * `listMessagesForApplication` with no client component underneath.
 *
 * `bodyRef` (a stored file path) is deliberately never turned into a
 * download link: P1 shipped no file-serving route, and the classifier
 * already works off `snippet` alone, so building one now would be
 * speculative — a YAGNI call, not an oversight. If a real need for the full
 * body shows up later, this is the one place that would grow a link.
 */
export function Messages({ messages }: { messages: EmailMessage[] }) {
  return (
    <Section title="Messages">
      {messages.length === 0 ? (
        <EmptyState title="No messages yet" hint="No email messages for this application yet." />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {messages.map((message) => (
            <li
              key={message.id}
              className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-4 shadow-card"
            >
              <div className="flex flex-wrap items-center gap-2">
                {/* Sent is the applicant's own confirmed action (`ok`); a
                    received message is just system state to read, `neutral`. */}
                <Badge tone={message.direction === "inbound" ? "neutral" : "ok"}>
                  {message.direction === "inbound" ? "Received" : "Sent"}
                </Badge>
                {message.classification && <Badge tone="neutral">{humanize(message.classification)}</Badge>}
                <span className="text-xs text-soft">{formatTimestamp(message.receivedAt)}</span>
              </div>
              <p className="m-0 text-sm font-semibold text-ink">{message.subject || "(no subject)"}</p>
              <p className="m-0 text-xs text-muted">
                {message.direction === "inbound" ? `From ${message.fromAddr}` : `To ${message.toAddrs.join(", ")}`}
              </p>
              <p className="m-0 text-sm text-ink">{message.snippet}</p>
              {message.bodyRef && (
                <p className="m-0 text-xs italic text-soft">
                  Full body stored — download is not available in this build.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
