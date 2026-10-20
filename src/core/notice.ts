/**
 * Words for the transcript's machinery rows.
 *
 * The backend stores injected turns — "a background process finished", "3
 * delegations completed", "the model changed" — with `role: "user"` and a body
 * written FOR THE MODEL (`[IMPORTANT: …]`, `[System: …]`). A reopened session
 * that pasted that body into a bubble read as though the user had sent a log
 * dump; the projection turns those rows into notices (`core/history.ts`) and
 * this module gives each one a sentence in the reader's language.
 *
 * Pure string logic, no DOM (AGENTS.md 铁律 1).
 */

import { messagesFor, type Locale } from "./i18n";
import type { NoticeItem } from "./types";

/**
 * How many children a delegation batch reported.
 *
 * The batch row names the count in prose ("3 background processes completed")
 * and then repeats each child in its own `[IMPORTANT: …]` envelope. Counting the
 * envelopes is the reliable number — the prose is a translated string upstream —
 * so prose is only the fallback, and one is the floor (a batch that says nothing
 * still finished *something*).
 */
export function subagentCount(detail: string): number {
  const envelopes = detail.match(/\[IMPORTANT:/g)?.length ?? 0;
  if (envelopes > 0) return envelopes;
  const prose = /(\d+)\s+(?:background\s+)?(?:process|agent|delegat|subagent|task)/i.exec(detail);
  return prose ? Math.max(1, Number(prose[1])) : 1;
}

/** The body a notice renders; an unknown kind keeps whatever text it carried. */
export function noticeText(item: NoticeItem, locale: Locale): string {
  const t = messagesFor(locale);
  switch (item.noticeKind) {
    case "process":
      return t.noticeProcess;
    case "subagents":
      return t.noticeSubagents(subagentCount(item.detail ?? item.text));
    case "background":
      return t.noticeBackground;
    case "model":
      return t.noticeModel;
    case "continue":
      return t.noticeContinue;
    case "personality":
      return t.noticePersonality;
    default:
      return item.text;
  }
}
