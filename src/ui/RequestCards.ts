/**
 * The two server→client request cards: approval and clarify.
 *
 * Rendering only. Every decision (which choices the server offered, how a
 * multi-select answer is joined, when the batch is submittable) lives in
 * `core/requests.ts`, where it is testable without a DOM — that is where the
 * previous version's bug hid, when it hardcoded the approval choices and ignored
 * the server's own list.
 *
 * The backend blocks on these answers (clarify for up to 3600s), so a card must
 * always be answerable.
 */

import type * as ReactNS from "react";

import { messagesFor, type Locale } from "../core/i18n";
import {
  approvalLabel,
  approvalResult,
  clarifyReady,
  clarifyResult,
  parseApproval,
  parseClarifyQuestions,
  stageChoice,
  stageFreeText,
  stagedAnswerParts,
  type ApprovalChoice,
} from "../core/requests";
import type { HermesPluginSdk } from "./sdk";

export interface RequestCard {
  id: string;
  method: string;
  params: Record<string, unknown>;
  respond: (result: Record<string, unknown>) => void;
  fail: (code: number, message: string) => void;
}

function cardShell(sdk: HermesPluginSdk, accent: string, children: ReactNS.ReactNode) {
  const { React } = sdk;
  return React.createElement(
    "div",
    {
      className: "px-3 py-2 text-xs hb-bubble-gap",
      "data-hb": "request-card",
      style: {
        maxWidth: "min(72ch, 82%)",
        background: `color-mix(in oklab, ${accent} 10%, var(--color-card))`,
        borderRadius: "var(--radius)",
        borderLeft: `2px solid ${accent}`,
      },
    },
    children,
  );
}

const CODE_STYLE = {
  padding: "0.5rem",
  fontFamily: "var(--hb-font-mono)",
  fontSize: "0.8125rem",
  background: "color-mix(in oklab, var(--color-muted) 70%, transparent)",
  borderRadius: "calc(var(--radius) * 0.6)",
};

export function ApprovalCard({
  sdk,
  card,
  locale,
  onAnswer,
}: {
  sdk: HermesPluginSdk;
  card: RequestCard;
  locale: Locale;
  onAnswer: (choice: ApprovalChoice) => void;
}) {
  const { React } = sdk;
  const t = messagesFor(locale);
  const view = parseApproval(card.params);

  return cardShell(
    sdk,
    "var(--color-destructive)",
    React.createElement(
      "div",
      null,
      React.createElement(
        "div",
        { className: "flex items-center gap-2" },
        React.createElement("span", { className: "font-medium" }, t.approvalTitle),
        view.toolName
          ? React.createElement(
              "span",
              { className: "hb-text-micro", style: { color: "var(--color-muted-foreground)" } },
              view.toolName,
            )
          : null,
      ),
      view.description
        ? React.createElement(
            "div",
            { className: "hb-mt-sm", style: { color: "var(--color-muted-foreground)" } },
            view.description,
          )
        : null,
      view.command
        ? React.createElement("pre", { className: "hb-output hb-mt-sm", style: CODE_STYLE }, view.command)
        : null,
      React.createElement(
        "div",
        { className: "hb-stack-gap hb-choice-col" },
        view.choices.map((choice) =>
          React.createElement(
            "button",
            {
              key: choice,
              type: "button",
              "data-hb-choice": choice,
              className: "hb-action-btn-text hb-choice-row",
              style: {
                background: choice === "deny" ? "var(--color-muted)" : "var(--color-primary)",
                color:
                  choice === "deny" ? "var(--color-muted-foreground)" : "var(--color-primary-foreground)",
                borderRadius: "calc(var(--radius) * 0.6)",
              },
              onClick: () => onAnswer(choice),
            },
            approvalLabel(choice, locale),
          ),
        ),
      ),
    ),
  );
}

export function ClarifyCard({
  sdk,
  card,
  locale,
  onSubmit,
}: {
  sdk: HermesPluginSdk;
  card: RequestCard;
  locale: Locale;
  onSubmit: (result: { answers: Record<string, string> | null }) => void;
}) {
  const { React } = sdk;
  const { useState } = sdk.hooks;
  const t = messagesFor(locale);

  const questions = parseClarifyQuestions(card.params);
  const [picked, setPicked] = useState<Record<string, string[]>>({});

  const stage = (qid: string, values: string[]) => {
    setPicked((prev: Record<string, string[]>) => ({ ...prev, [qid]: values }));
  };

  const ready = clarifyReady(questions, picked);

  return cardShell(
    sdk,
    "var(--color-ring)",
    React.createElement(
      "div",
      { className: "space-y-2" },
      React.createElement("div", { className: "font-medium" }, t.clarifyTitle),
      questions.map((q) => {
        const on = picked[q.qid] ?? [];
        const { text } = stagedAnswerParts(q, on);
        // Every question ends with a free-text row, whether or not the server
        // offered choices: the model's list is a guess at what the user means,
        // and a card with no way to say "none of these" is a card that gets
        // answered wrongly or cancelled. The desktop app does the same ("Other"),
        // and the wire accepts any string here — `answers` is free-form.
        const freeText = React.createElement(
          "input",
          {
            key: `${q.qid}-free`,
            type: "text",
            className: q.choices.length ? "hb-choice-row hb-input hb-choice-input" : "hb-mt-sm hb-input",
            "data-hb-input": q.qid,
            "data-hb": "clarify-other",
            "aria-label": q.choices.length ? t.clarifyOther : q.question,
            placeholder: q.choices.length ? t.clarifyOther : undefined,
            value: text,
            onChange: (event: { target: { value: string } }) => stage(q.qid, stageFreeText(q, on, event.target.value)),
          },
        );
        if (!q.choices.length) {
          return React.createElement("div", { key: q.qid }, React.createElement("div", null, q.question), freeText);
        }
        return React.createElement(
          "div",
          { key: q.qid },
          React.createElement("div", null, q.question),
          React.createElement(
            "div",
            { className: "hb-mt-sm hb-choice-col" },
            q.choices.map((choice) =>
              React.createElement(
                "button",
                {
                  key: choice,
                  type: "button",
                  "data-hb-choice": choice,
                  "data-hb-selected": on.includes(choice) ? "true" : "false",
                  className: "hb-action-btn-text hb-choice-row",
                  style: {
                    background: on.includes(choice) ? "var(--color-primary)" : "var(--color-muted)",
                    color: on.includes(choice)
                      ? "var(--color-primary-foreground)"
                      : "var(--color-card-foreground)",
                    borderRadius: "calc(var(--radius) * 0.6)",
                  },
                  onClick: () => stage(q.qid, stageChoice(q, on, choice)),
                },
                choice,
              ),
            ),
            // Last row, styled as a member of the same list rather than as a
            // form field: the point is "these are the options; this one is
            // yours", so it must not read as a separate thing below the list.
            freeText,
          ),
        );
      }),
      React.createElement(
        "div",
        { className: "hb-stack-gap" },
        React.createElement(
          "button",
          {
            type: "button",
            "data-hb": "clarify-submit",
            disabled: !ready,
            className: "hb-action-btn-text",
            style: {
              background: "var(--color-primary)",
              color: "var(--color-primary-foreground)",
              borderRadius: "calc(var(--radius) * 0.6)",
              opacity: ready ? 1 : 0.4,
              cursor: ready ? "pointer" : "default",
            },
            onClick: () => onSubmit(clarifyResult(picked)),
          },
          t.submit,
        ),
      ),
    ),
  );
}

export { approvalResult };
