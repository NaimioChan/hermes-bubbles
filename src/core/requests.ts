/**
 * The two blocking server→client requests, as data.
 *
 * The backend asks the renderer a question mid-turn and waits (clarify waits
 * 3600s), so getting these shapes wrong stalls the agent rather than merely
 * looking odd. The parsing is here, pure, so it can be tested without rendering
 * a card — the previous version had this logic inline in the component, where
 * the bug (ignoring the server's own `choices` list) was invisible to every test.
 *
 * Contracts (hermes-agent 0.22.2):
 *
 *   approval → params { request_id, command, description, choices: ApprovalChoice[],
 *                       allow_permanent?, allow_session?, smart_denied?, tool_name? }
 *              result { choice, all? }
 *              ApprovalChoice = once | session | always | deny
 *
 *   clarify  → params { questions: [{ qid, question, choices?, multi_select }] }
 *              result { answers: { [qid]: string | null } | null }
 *              A result with no `answers` is cancel-all.
 *
 * Pure data (AGENTS.md 铁律 1).
 */

import type { Locale } from "./i18n";
import { messagesFor } from "./i18n";

export type ApprovalChoice = "once" | "session" | "always" | "deny";

const APPROVAL_CHOICES: readonly ApprovalChoice[] = ["once", "session", "always", "deny"];

const APPROVAL_LABEL_KEY = {
  once: "approvalOnce",
  session: "approvalSession",
  always: "approvalAlways",
  deny: "approvalDeny",
} as const;

export interface ApprovalView {
  requestId: string;
  command: string;
  description: string;
  toolName: string;
  /** Exactly what the server offered, in its own order. */
  choices: ApprovalChoice[];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Narrow one wire value to a known choice; anything else is dropped. */
function toChoice(value: unknown): ApprovalChoice | null {
  return typeof value === "string" && (APPROVAL_CHOICES as readonly string[]).includes(value)
    ? (value as ApprovalChoice)
    : null;
}

/**
 * Read an approval request off the wire.
 *
 * The offered list comes from the server. It is NOT defaulted to all four
 * choices: a command the backend only permits "once" would otherwise show
 * "Always allow", and the user would pick an option the backend then has to
 * refuse. Only when the server truly sends none does this fall back.
 */
export function parseApproval(params: Record<string, unknown>): ApprovalView {
  const raw = Array.isArray(params.choices) ? params.choices : [];
  const parsed = raw.map(toChoice).filter((c): c is ApprovalChoice => c !== null);
  return {
    requestId: str(params.request_id),
    command: str(params.command),
    description: str(params.description),
    toolName: str(params.tool_name),
    choices: parsed.length ? parsed : [...APPROVAL_CHOICES],
  };
}

export function approvalLabel(choice: ApprovalChoice, locale: Locale): string {
  return messagesFor(locale)[APPROVAL_LABEL_KEY[choice]];
}

/** The approval result the backend expects for a picked choice. */
export function approvalResult(choice: ApprovalChoice): { choice: ApprovalChoice } {
  return { choice };
}

// ── clarify ──────────────────────────────────────────────────────────────────

export interface ClarifyQuestionView {
  qid: string;
  question: string;
  choices: string[];
  multiSelect: boolean;
}

export function parseClarifyQuestions(params: Record<string, unknown>): ClarifyQuestionView[] {
  const raw = Array.isArray(params.questions) ? params.questions : [];
  const out: ClarifyQuestionView[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const q = entry as Record<string, unknown>;
    const qid = str(q.qid);
    if (!qid) continue;
    out.push({
      qid,
      question: str(q.question),
      choices: Array.isArray(q.choices) ? q.choices.filter((c): c is string => typeof c === "string") : [],
      multiSelect: q.multi_select === true,
    });
  }
  return out;
}

/**
 * Join the picked values for one question.
 *
 * `ClarifyResult.answers` is `Record<string, string>` — one string per question —
 * so a multi-select answer is joined rather than sent as a list. An unanswered
 * question is omitted entirely (the backend reads a missing key as a skip).
 */
export function clarifyAnswer(values: readonly string[]): string | null {
  const picked = values.filter((v) => v.trim().length > 0);
  if (!picked.length) return null;
  return picked.join(", ");
}

/** The clarify result for a set of answers. No usable answer ⇒ cancel-all. */
export function clarifyResult(answers: Record<string, readonly string[]>): { answers: Record<string, string> | null } {
  const out: Record<string, string> = {};
  for (const [qid, values] of Object.entries(answers)) {
    const joined = clarifyAnswer(values);
    if (joined !== null) out[qid] = joined;
  }
  return { answers: Object.keys(out).length ? out : null };
}

/** Whether every question has an answer, i.e. the batch can be submitted. */
export function clarifyReady(questions: readonly ClarifyQuestionView[], answers: Record<string, readonly string[]>): boolean {
  return questions.every((q) => clarifyAnswer(answers[q.qid] ?? []) !== null);
}
