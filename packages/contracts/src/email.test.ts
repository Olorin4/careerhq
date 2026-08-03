import { describe, expect, it } from "vitest";
import {
  classifyReplyResultSchema, emailDraftSchema, imapConfigSchema,
  retentionSettingSchema, smtpConfigSchema,
} from "./index.js";

describe("email contracts (spec §9)", () => {
  it("retention days_limited requires days; default is metadata_only", () => {
    expect(retentionSettingSchema.safeParse({ mode: "days_limited" }).success).toBe(false);
    expect(retentionSettingSchema.parse({}).mode).toBe("metadata_only");
    expect(retentionSettingSchema.parse({ mode: "days_limited", days: 30 }).days).toBe(30);
  });
  it("smtp defaults starttls, imap defaults implicit + INBOX", () => {
    const s = smtpConfigSchema.parse({ host: "smtp.x.example", port: "587", username: "u" });
    expect(s.tls).toBe("starttls");
    expect(s.port).toBe(587);
    const i = imapConfigSchema.parse({ host: "imap.x.example", port: 993, username: "u" });
    expect(i.folders).toEqual(["INBOX"]);
  });
  it("draft requires valid recipient and non-empty subject/body", () => {
    expect(emailDraftSchema.safeParse({ to: "not-an-email", subject: "s", body: "b" }).success).toBe(false);
    expect(emailDraftSchema.safeParse({ to: "hr@acme.example", subject: " ", body: "b" }).success).toBe(false);
  });
  it("classification result bounds confidence and allows suggestedState", () => {
    const r = classifyReplyResultSchema.parse({ classification: "interview", confidence: 0.8, suggestedState: "INTERVIEW" });
    expect(r.quotedEvidence).toBe("");
    expect(classifyReplyResultSchema.safeParse({ classification: "spam", confidence: 0.5 }).success).toBe(false);
  });
});
