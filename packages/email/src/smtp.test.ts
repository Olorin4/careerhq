import { describe, expect, it } from "vitest";
import type { SmtpConfig } from "@careerhq/contracts";
import {
  makeSmtpTransport,
  sendApplicationEmail,
  verifySmtpConnection,
  type SmtpSendRequest,
  type SmtpTransportLike,
} from "./smtp.js";

function makeRequest(overrides: Partial<SmtpSendRequest> = {}): SmtpSendRequest {
  return {
    from: "Jane Doe <jane@example.com>",
    to: "recruiter@example.com",
    subject: "Application",
    text: "Please find my application attached.",
    attachments: [],
    messageIdDomain: "example.com",
    ...overrides,
  };
}

function stubTransport(overrides: Partial<SmtpTransportLike> = {}): SmtpTransportLike {
  return {
    verify: async () => true,
    sendMail: async () => ({ messageId: "<default@example.com>", accepted: [], rejected: [] }),
    ...overrides,
  };
}

describe("sendApplicationEmail", () => {
  it("returns sent when the recipient is accepted", async () => {
    const transport = stubTransport({
      sendMail: async () => ({
        messageId: "<abc123@example.com>",
        accepted: ["recruiter@example.com"],
        rejected: [],
      }),
    });
    const result = await sendApplicationEmail(transport, makeRequest(), []);
    expect(result).toEqual({ status: "sent", messageId: "<abc123@example.com>" });
  });

  it("returns failed with 'recipient rejected' when the recipient is rejected", async () => {
    const transport = stubTransport({
      sendMail: async () => ({
        messageId: "<abc123@example.com>",
        accepted: [],
        rejected: ["recruiter@example.com"],
      }),
    });
    const result = await sendApplicationEmail(transport, makeRequest(), []);
    expect(result.status).toBe("failed");
    expect((result as { reason: string }).reason).toBe("recipient rejected");
  });

  it("returns failed with the password redacted for an EAUTH rejection", async () => {
    const transport = stubTransport({
      sendMail: async () => {
        const err = new Error("535 5.7.8 authentication failed for pass hunter2") as Error & {
          code: string;
        };
        err.code = "EAUTH";
        throw err;
      },
    });
    const result = await sendApplicationEmail(transport, makeRequest(), ["hunter2"]);
    expect(result.status).toBe("failed");
    const reason = (result as { reason: string }).reason;
    expect(reason).not.toContain("hunter2");
    expect(reason).toContain("[redacted]");
  });

  it("returns uncertain when the failure occurs during the DATA command", async () => {
    const transport = stubTransport({
      sendMail: async () => {
        const err = new Error("connection dropped mid-transfer") as Error & { command: string };
        err.command = "DATA";
        throw err;
      },
    });
    const result = await sendApplicationEmail(transport, makeRequest(), []);
    expect(result.status).toBe("uncertain");
  });

  it("returns uncertain when the failure occurs at end DATA", async () => {
    const transport = stubTransport({
      sendMail: async () => {
        const err = new Error("connection dropped at end of data") as Error & {
          command: string;
          code: string;
        };
        err.command = "end DATA";
        err.code = "ETIMEDOUT";
        throw err;
      },
    });
    const result = await sendApplicationEmail(transport, makeRequest(), []);
    expect(result.status).toBe("uncertain");
  });

  it("returns uncertain for an ETIMEDOUT during a DATA-prefixed command", async () => {
    const transport = stubTransport({
      sendMail: async () => {
        const err = new Error("timed out") as Error & { command: string; code: string };
        err.command = "DATA_STREAM";
        err.code = "ETIMEDOUT";
        throw err;
      },
    });
    const result = await sendApplicationEmail(transport, makeRequest(), []);
    expect(result.status).toBe("uncertain");
  });

  it("returns failed for an ETIMEDOUT on an unrelated command", async () => {
    const transport = stubTransport({
      sendMail: async () => {
        const err = new Error("timed out") as Error & { command: string; code: string };
        err.command = "RCPT TO";
        err.code = "ETIMEDOUT";
        throw err;
      },
    });
    const result = await sendApplicationEmail(transport, makeRequest(), []);
    expect(result.status).toBe("failed");
  });
});

describe("verifySmtpConnection", () => {
  it("returns ok true when verify resolves", async () => {
    const transport = stubTransport({ verify: async () => true });
    expect(await verifySmtpConnection(transport, [])).toEqual({ ok: true });
  });

  it("returns ok false with a redacted reason when verify rejects", async () => {
    const transport = stubTransport({
      verify: async () => {
        throw new Error("bad credentials: hunter2");
      },
    });
    const result = await verifySmtpConnection(transport, ["hunter2"]);
    expect(result.ok).toBe(false);
    const reason = (result as { reason: string }).reason;
    expect(reason).not.toContain("hunter2");
  });
});

describe("makeSmtpTransport flag mapping", () => {
  const baseCfg: SmtpConfig = {
    host: "smtp.example.com",
    port: 587,
    username: "jane@example.com",
    tls: "starttls",
  };

  it("maps tls=starttls to requireTLS", () => {
    const transport = makeSmtpTransport({ ...baseCfg, tls: "starttls" }, "password");
    const options = transport.transporter.options as {
      secure?: boolean;
      requireTLS?: boolean;
      ignoreTLS?: boolean;
    };
    expect(options.secure).toBe(false);
    expect(options.requireTLS).toBe(true);
    expect(options.ignoreTLS).toBe(false);
  });

  it("maps tls=implicit to secure", () => {
    const transport = makeSmtpTransport({ ...baseCfg, tls: "implicit" }, "password");
    const options = transport.transporter.options as {
      secure?: boolean;
      requireTLS?: boolean;
      ignoreTLS?: boolean;
    };
    expect(options.secure).toBe(true);
    expect(options.requireTLS).toBe(false);
    expect(options.ignoreTLS).toBe(false);
  });

  it("maps tls=none to ignoreTLS", () => {
    const transport = makeSmtpTransport({ ...baseCfg, tls: "none" }, "password");
    const options = transport.transporter.options as {
      secure?: boolean;
      requireTLS?: boolean;
      ignoreTLS?: boolean;
    };
    expect(options.secure).toBe(false);
    expect(options.requireTLS).toBe(false);
    expect(options.ignoreTLS).toBe(true);
  });
});
