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
  fontFamily: "var(--font-mono)",
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
        { className: "hb-stack-gap flex flex-wrap gap-2" },
        view.choices.map((choice) =>
          React.createElement(
            "button",
            {
              key: choice,
              type: "button",
              "data-hb-choice": choice,
              className: "hb-action-btn-text",
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

  const toggle = (qid: string, value: string, multi: boolean) => {
    setPicked((prev: Record<string, string[]>) => {
      const current = prev[qid] ?? [];
      if (!multi) return { ...prev, [qid]: current[0] === value ? [] : [value] };
      return {
        ...prev,
        [qid]: current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
      };
    });
  };

  const setFreeText = (qid: string, value: string) => {
    setPicked((prev: Record<string, string[]>) => ({ ...prev, [qid]: value ? [value] : [] }));
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
        return React.createElement(
          "div",
          { key: q.qid },
          React.createElement("div", null, q.question),
          q.choices.length
            ? React.createElement(
                "div",
                { className: "hb-mt-sm flex flex-wrap gap-2" },
                q.choices.map((choice) =>
                  React.createElement(
                    "button",
                    {
                      key: choice,
                      type: "button",
                      "data-hb-choice": choice,
                      "data-hb-selected": on.includes(choice) ? "true" : "false",
                      className: "hb-action-btn-text",
                      style: {
                        background: on.includes(choice) ? "var(--color-primary)" : "var(--color-muted)",
                        color: on.includes(choice)
                          ? "var(--color-primary-foreground)"
                          : "var(--color-card-foreground)",
                        borderRadius: "calc(var(--radius) * 0.6)",
                      },
                      onClick: () => toggle(q.qid, choice, q.multiSelect),
                    },
                    choice,
                  ),
                ),
              )
            : React.createElement("input", {
                type: "text",
                className: "hb-mt-sm hb-input",
                "data-hb-input": q.qid,
                "aria-label": q.question,
                onChange: (event: { target: { value: string } }) => setFreeText(q.qid, event.target.value),
              }),
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
