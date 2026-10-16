/**
 * The page: session header, transcript, composer, approval cards.
 *
 * This is the component the registry mounts at `/chat`. It owns a
 * `ChatController` and re-renders from it through `useSyncExternalStore`, so a
 * streaming turn costs one render per event batch and nothing re-renders that
 * did not change.
 */

import { ChatController, type ServerRequestCard } from "../app/controller";
import type { Timeline } from "../core/types";
import { Bubble } from "./Bubble";
import { runningLabel } from "./format";
import type { HermesPluginSdk } from "./sdk";

interface ApprovalCardState extends ServerRequestCard {
  kind: "approval" | "clarify";
}

function Composer({
  sdk,
  running,
  status,
  onSend,
  onStop,
  disabled,
}: {
  sdk: HermesPluginSdk;
  running: boolean;
  status: string;
  onSend: (text: string) => void;
  onStop: () => void;
  disabled: boolean;
}) {
  const { React } = sdk;
  const { useState, useRef } = sdk.hooks;
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const submit = () => {
    const value = text.trim();
    if (!value || running) return;
    setText("");
    onSend(value);
  };

  const onKeyDown = (event: { key: string; shiftKey: boolean; preventDefault: () => void }) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return React.createElement(
    "div",
    { className: "px-4 pb-4 pt-2" },
    React.createElement(
      "div",
      {
        className: "mx-auto flex items-end gap-2 px-2 py-1.5",
        style: {
          maxWidth: "860px",
          background: "var(--color-card)",
          borderRadius: "var(--radius)",
          boxShadow: "inset 0 0 0 1px var(--color-border)",
        },
      },
      React.createElement("textarea", {
        ref,
        value: text,
        disabled,
        rows: 1,
        placeholder: disabled ? "连接中…" : "发消息给 Hermes（Enter 发送，Shift+Enter 换行）",
        className: "max-h-40 min-h-[2rem] flex-1 resize-none bg-transparent py-1.5 text-sm outline-none",
        style: { color: "var(--color-foreground)", fontFamily: "var(--font-sans)" },
        onChange: (event: { target: { value: string } }) => setText(event.target.value),
        onKeyDown,
      }),
      running
        ? React.createElement(
            "button",
            {
              type: "button",
              className: "shrink-0 cursor-pointer px-3 py-1.5 text-xs",
              style: {
                background: "var(--color-destructive)",
                color: "var(--color-destructive-foreground, #fff)",
                borderRadius: "calc(var(--radius) * 0.6)",
              },
              onClick: onStop,
            },
            "停止",
          )
        : React.createElement(
            "button",
            {
              type: "button",
              disabled: !text.trim() || disabled,
              className: "shrink-0 cursor-pointer px-3 py-1.5 text-xs disabled:opacity-40",
              style: {
                background: "var(--color-primary)",
                color: "var(--color-primary-foreground)",
                borderRadius: "calc(var(--radius) * 0.6)",
              },
              onClick: submit,
            },
            "发送",
          ),
    ),
    status
      ? React.createElement(
          "div",
          {
            className: "mx-auto mt-1 px-2 text-[0.6875rem]",
            style: { maxWidth: "860px", color: "var(--color-muted-foreground)" },
          },
          status,
        )
      : null,
  );
}

function ApprovalCardView({
  sdk,
  card,
  onAnswer,
}: {
  sdk: HermesPluginSdk;
  card: ApprovalCardState;
  onAnswer: (card: ApprovalCardState, choice: string) => void;
}) {
  const { React } = sdk;
  const choices = (card.params.choices as string[] | undefined) ?? ["once", "session", "always", "deny"];
  const labels: Record<string, string> = {
    once: "允许一次",
    session: "本次会话允许",
    always: "总是允许",
    deny: "拒绝",
  };

  return React.createElement(
    "div",
    {
      className: "px-3 py-2 text-xs",
      style: {
        maxWidth: "min(72ch, 82%)",
        background: "color-mix(in oklab, var(--color-destructive) 10%, var(--color-card))",
        borderRadius: "var(--radius)",
        borderLeft: "2px solid var(--color-destructive)",
      },
    },
    React.createElement("div", { className: "font-medium" }, "需要你确认"),
    card.params.command
      ? React.createElement(
          "pre",
          {
            className: "mt-1 overflow-x-auto whitespace-pre-wrap break-words p-2",
            style: {
              fontFamily: "var(--font-mono)",
              fontSize: "0.8125rem",
              background: "var(--color-background)",
              borderRadius: "calc(var(--radius) * 0.6)",
            },
          },
          String(card.params.command),
        )
      : null,
    React.createElement(
      "div",
      { className: "mt-2 flex flex-wrap gap-2" },
      choices.map((choice) =>
        React.createElement(
          "button",
          {
            key: choice,
            type: "button",
            className: "cursor-pointer px-2.5 py-1",
            style: {
              background: choice === "deny" ? "var(--color-muted)" : "var(--color-primary)",
              color: choice === "deny" ? "var(--color-muted-foreground)" : "var(--color-primary-foreground)",
              borderRadius: "calc(var(--radius) * 0.6)",
            },
            onClick: () => onAnswer(card, choice),
          },
          labels[choice] ?? choice,
        ),
      ),
    ),
  );
}

function ClarifyCardView({
  sdk,
  card,
  onAnswer,
}: {
  sdk: HermesPluginSdk;
  card: ApprovalCardState;
  onAnswer: (card: ApprovalCardState, answers: Record<string, string>) => void;
}) {
  const { React } = sdk;
  const questions = (card.params.questions as { qid: string; question: string; choices?: string[] }[] | undefined) ?? [];
  return React.createElement(
    "div",
    {
      className: "space-y-2 px-3 py-2 text-xs",
      style: {
        maxWidth: "min(72ch, 82%)",
        background: "color-mix(in oklab, var(--color-primary) 8%, var(--color-card))",
        borderRadius: "var(--radius)",
        borderLeft: "2px solid var(--color-ring)",
      },
    },
    questions.map((question) =>
      React.createElement(
        "div",
        { key: question.qid },
        React.createElement("div", { className: "font-medium" }, question.question),
        question.choices
          ? React.createElement(
              "div",
              { className: "mt-1 flex flex-wrap gap-2" },
              question.choices.map((choice) =>
                React.createElement(
                  "button",
                  {
                    key: choice,
                    type: "button",
                    className: "cursor-pointer px-2.5 py-1",
                    style: {
                      background: "var(--color-muted)",
                      color: "var(--color-foreground)",
                      borderRadius: "calc(var(--radius) * 0.6)",
                    },
                    onClick: () => onAnswer(card, { [question.qid]: choice }),
                  },
                  choice,
                ),
              ),
            )
          : null,
      ),
    ),
  );
}

export function ChatPage({ sdk }: { sdk: HermesPluginSdk }) {
  const { React } = sdk;
  const { useCallback, useEffect, useMemo, useRef, useState } = sdk.hooks;
  // `useSyncExternalStore` is NOT in the SDK's curated hooks map — take it off
  // the React instance itself. Verified against SDK_CONTRACT_VERSION 1.1.0.
  const useSyncExternalStore = React.useSyncExternalStore;

  const controller = useMemo(
    () =>
      new ChatController({
        urlProvider: () => sdk.buildWsUrl("/api/ws"),
      }),
    [sdk],
  );
  const [cards, setCards] = useState<ApprovalCardState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const timeline = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  ) as Timeline;

  useEffect(() => {
    controller.setServerRequestSink((card) => {
      setCards((prev) => [...prev, { ...card, kind: card.method === "approval" ? "approval" : "clarify" }]);
    });
    controller.connect();
    controller.openSession().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      controller.setServerRequestSink(null);
      controller.dispose();
    };
  }, [controller]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [timeline.items.length, timeline.items.at(-1)]);

  const answer = useCallback(
    (card: ApprovalCardState, choice: string) => {
      card.respond(card.kind === "approval" ? { choice } : { answers: choice as unknown as Record<string, string> });
      setCards((prev) => prev.filter((c) => c.id !== card.id));
    },
    [],
  );

  const answerClarify = useCallback((card: ApprovalCardState, answers: Record<string, string>) => {
    card.respond({ answers });
    setCards((prev) => prev.filter((c) => c.id !== card.id));
  }, []);

  const onSend = useCallback(
    (text: string) => {
      setError(null);
      controller.send(text).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [controller],
  );

  const onStop = useCallback(() => {
    controller.interrupt().catch(() => undefined);
  }, [controller]);

  const status = runningLabel({ status: timeline.meta.status, running: timeline.meta.running });

  return React.createElement(
    "div",
    { className: "flex h-full min-h-0 flex-col" },
    React.createElement(
      "div",
      { className: "min-h-0 flex-1 overflow-y-auto px-4 py-4" },
      React.createElement(
        "div",
        { className: "mx-auto flex flex-col gap-3", style: { maxWidth: "860px" } },
        timeline.items.length === 0
          ? React.createElement(
              "div",
              {
                className: "py-16 text-center text-sm",
                style: { color: "var(--color-muted-foreground)" },
              },
              "开始一段对话。",
            )
          : timeline.items.map((item) => React.createElement(Bubble, { key: item.id, sdk, item })),
        cards.map((card) =>
          React.createElement(
            "div",
            { key: card.id },
            card.kind === "approval"
              ? React.createElement(ApprovalCardView, { sdk, card, onAnswer: answer })
              : React.createElement(ClarifyCardView, { sdk, card, onAnswer: answerClarify }),
          ),
        ),
        error
          ? React.createElement(
              "div",
              { className: "text-xs", style: { color: "var(--color-destructive)" } },
              error,
            )
          : null,
        React.createElement("div", { ref: bottomRef }),
      ),
    ),
    React.createElement(Composer, {
      sdk,
      running: timeline.meta.running,
      status,
      onSend,
      onStop,
      disabled: !timeline.meta.connected,
    }),
  );
}
