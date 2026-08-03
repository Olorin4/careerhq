import type { EmailMessage } from "@careerhq/db";

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
    <section className="messages">
      <h2>Messages</h2>
      {messages.length === 0 ? (
        <p className="messages-empty">No email messages for this application yet.</p>
      ) : (
        <ul className="messages-list">
          {messages.map((message) => (
            <li key={message.id} className="messages-row">
              <div className="messages-row-meta">
                <span className={message.direction === "inbound" ? "badge" : "badge badge-ok"}>
                  {message.direction === "inbound" ? "Received" : "Sent"}
                </span>
                {message.classification && <span className="badge">{humanize(message.classification)}</span>}
                <span className="messages-row-date">{message.receivedAt.toLocaleString()}</span>
              </div>
              <p className="messages-row-subject">
                <strong>{message.subject || "(no subject)"}</strong>
              </p>
              <p className="messages-row-addr">
                {message.direction === "inbound" ? `From ${message.fromAddr}` : `To ${message.toAddrs.join(", ")}`}
              </p>
              <p className="messages-row-snippet">{message.snippet}</p>
              {message.bodyRef && (
                <p className="messages-row-note">
                  Full body stored — download is not available in this build.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
