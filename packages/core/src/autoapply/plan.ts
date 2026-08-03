import type {
  AnswerSource,
  CanonicalField,
  CanonicalForm,
  CanonicalFormField,
  PlannedAnswer,
} from "@careerhq/contracts";
import { classifyQuestionSensitivity, mergeSensitivityRulings } from "../grounding/sensitive.js";
import { normalizeQuestion } from "../grounding/select-facts.js";

/** Deterministic identity/contact values sourced from the Fact Bank. */
export interface ProfileValues {
  full_name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  location?: string;
  linkedin_url?: string;
  github_url?: string;
  portfolio_url?: string;
  current_company?: string;
  current_title?: string;
}

export interface SavedAnswerLike {
  questionNorm: string;
  answer: string;
  sourceFactIds: string[];
  staleForReuse: boolean;
}

export interface PlanInputs {
  form: CanonicalForm;
  profile: ProfileValues;
  savedAnswers: SavedAnswerLike[];
  /** cv_variant/document id used for file fields; null when nothing is attached. */
  resumeDocumentId: string | null;
  /** questionNorm → previously approved answer, used for diffing. */
  previouslyApproved: Record<string, string>;
}

export interface PlanResult {
  answers: PlannedAnswer[];
  /** Field ids left for the user with no deterministic source (AI-drafting candidates, Task 11). */
  unresolved: string[];
}

/** Below this a mapped value is still filled, but the user must confirm it. */
export const MIN_FILL_CONFIDENCE = 0.7;

const SAVED_ANSWER_CONFIDENCE = 0.9;
const STALE_SAVED_ANSWER_NOTE = "saved answer past review date";
const SENSITIVE_NOTE = "sensitive question — only you may answer this";
const LOW_CONFIDENCE_NOTE = "mapping confidence below fill threshold";
const MISSING_RESUME_NOTE = "no resume document attached";

/**
 * Canonical fields that may never be auto-answered by a model (spec §7.2.5).
 * This is one of two independent sensitivity signals — see `isSensitiveField`.
 */
export const SENSITIVE_CANONICAL_FIELDS: ReadonlySet<CanonicalField> = new Set<CanonicalField>([
  "work_authorization",
  "visa_sponsorship",
  "desired_salary",
  "demographics",
  "criminal_history",
  "legal_attestation",
  "notice_period",
  "availability",
  "relocation",
]);

/** Canonical fields backed by a deterministic profile value. */
const PROFILE_KEY_BY_CANONICAL_FIELD: Partial<Record<CanonicalField, keyof ProfileValues>> = {
  full_name: "full_name",
  first_name: "first_name",
  last_name: "last_name",
  email: "email",
  phone: "phone",
  location: "location",
  linkedin_url: "linkedin_url",
  github_url: "github_url",
  portfolio_url: "portfolio_url",
  current_company: "current_company",
  current_title: "current_title",
};

const FREE_TEXT_KINDS = new Set(["text", "textarea"]);

/**
 * A field is sensitive when EITHER signal says so: the canonical-field set, the
 * parser/interpreter ruling on the field, or the keyword ruleset applied to the raw label.
 * Keeping both independent means adapter mapping changes (e.g. Greenhouse now mapping
 * work_authorization at 0.9 where it previously left it "unknown") cannot weaken the block.
 */
export function isSensitiveField(field: CanonicalFormField): boolean {
  const labelRuling = classifyQuestionSensitivity(field.label);
  const widenedByField =
    SENSITIVE_CANONICAL_FIELDS.has(field.canonicalField) || field.sensitive ? true : null;
  return mergeSensitivityRulings(labelRuling, widenedByField);
}

interface Draft {
  value: string;
  source: AnswerSource;
  sourceFactIds: string[];
  confidence: number;
  needsUser: boolean;
  note: string;
  /** true → the field id joins `unresolved` (rule 5 fallthrough only). */
  unresolved: boolean;
}

function userDraft(note: string, unresolved: boolean): Draft {
  return {
    value: "",
    source: "user",
    sourceFactIds: [],
    confidence: 0,
    needsUser: true,
    note,
    unresolved,
  };
}

function savedAnswerDraft(saved: SavedAnswerLike): Draft {
  return {
    value: saved.answer,
    source: "saved_answer",
    sourceFactIds: [...saved.sourceFactIds],
    confidence: SAVED_ANSWER_CONFIDENCE,
    needsUser: saved.staleForReuse,
    note: saved.staleForReuse ? STALE_SAVED_ANSWER_NOTE : "",
    unresolved: false,
  };
}

function planField(
  field: CanonicalFormField,
  inputs: PlanInputs,
  saved: SavedAnswerLike | null,
): Draft {
  // Rule 1 — sensitive: only the user (or their own previously saved answer) may answer.
  // Never "ai", never a profile guess, regardless of mapping confidence.
  if (isSensitiveField(field)) {
    return saved ? savedAnswerDraft(saved) : userDraft(SENSITIVE_NOTE, false);
  }

  // Rule 2 — file fields: the resume comes from the attached document, everything else is manual.
  if (field.kind === "file") {
    if (field.canonicalField === "resume_file" && inputs.resumeDocumentId) {
      return {
        value: inputs.resumeDocumentId,
        source: "document",
        sourceFactIds: [],
        confidence: 1,
        needsUser: false,
        note: "",
        unresolved: false,
      };
    }
    return userDraft(field.canonicalField === "resume_file" ? MISSING_RESUME_NOTE : "", false);
  }

  // Rule 3 — profile-mapped fields with a deterministic value.
  const profileKey = PROFILE_KEY_BY_CANONICAL_FIELD[field.canonicalField];
  const profileValue = profileKey ? (inputs.profile[profileKey] ?? "").trim() : "";
  if (profileValue) {
    const lowConfidence = field.mappingConfidence < MIN_FILL_CONFIDENCE;
    return {
      value: profileValue,
      source: "profile",
      sourceFactIds: [],
      confidence: field.mappingConfidence,
      needsUser: lowConfidence,
      note: lowConfidence ? LOW_CONFIDENCE_NOTE : "",
      unresolved: false,
    };
  }

  // Rule 4 — screening questions / free text with an exact saved answer.
  const answerable = field.canonicalField === "screening_question" || FREE_TEXT_KINDS.has(field.kind);
  if (saved && answerable) {
    return savedAnswerDraft(saved);
  }

  // Rule 5 — everything else is the user's, and is offered for AI drafting downstream.
  return userDraft("", true);
}

export function planAnswers(inputs: PlanInputs): PlanResult {
  const savedByNorm = new Map<string, SavedAnswerLike>();
  for (const saved of inputs.savedAnswers) {
    if (saved.questionNorm && !savedByNorm.has(saved.questionNorm)) {
      savedByNorm.set(saved.questionNorm, saved);
    }
  }

  const answers: PlannedAnswer[] = [];
  const unresolved: string[] = [];

  for (const field of inputs.form.fields) {
    const questionNorm = normalizeQuestion(field.label);
    const saved = questionNorm ? (savedByNorm.get(questionNorm) ?? null) : null;
    const draft = planField(field, inputs, saved);

    const approved = questionNorm ? inputs.previouslyApproved[questionNorm] : undefined;
    const differsFromApproved =
      approved !== undefined && draft.value !== "" && draft.value !== approved;

    answers.push({
      fieldId: field.id,
      value: draft.value,
      source: draft.source,
      sourceFactIds: draft.sourceFactIds,
      confidence: draft.confidence,
      needsUser: draft.needsUser,
      differsFromApproved,
      note: draft.note,
    });

    if (draft.unresolved) unresolved.push(field.id);
  }

  return { answers, unresolved };
}

/**
 * Field ids that must be settled by the user before the form may be submitted:
 * a required field with a missing/empty answer, any field still flagged `needsUser`,
 * or a sensitive field carrying an "ai" answer — the last being a belt-and-braces
 * invariant `planAnswers` can never produce.
 */
export function requiresUserBeforeSubmit(
  answers: PlannedAnswer[],
  form: CanonicalForm,
): string[] {
  const answerByFieldId = new Map(answers.map((answer) => [answer.fieldId, answer]));
  const blocking: string[] = [];

  for (const field of form.fields) {
    const answer = answerByFieldId.get(field.id);
    if (!answer) {
      if (field.required) blocking.push(field.id);
      continue;
    }
    if (field.required && answer.value.trim() === "") {
      blocking.push(field.id);
      continue;
    }
    if (answer.needsUser) {
      blocking.push(field.id);
      continue;
    }
    if (answer.source === "ai" && isSensitiveField(field)) {
      blocking.push(field.id);
    }
  }

  return blocking;
}
