/**
 * The page: tab strip on top, transcript in the middle, history panel on the
 * right, composer at the bottom.
 *
 * This is what the registry mounts at `/chat`. It owns a `ChatController` and
 * re-renders from it through `useSyncExternalStore`, so a streaming turn costs
 * one render per event batch and nothing re-renders that did not change.
 *
 * Everything with a decision in it lives in `core/` or the controller; this file
 * is wiring and the state that is genuinely view-local (approval cards on
 * screen, the model picker's open flag, the history panel's collapsed state).
 */

import { addAttachment, removeAttachment, updateAttachment, type Attachment } from "../core/attachments";
import { entriesFromCatalog, type CommandEntry } from "../core/slash";
import { activeTimeline, runningKeys, type SessionTab } from "../core/sessions";
import type { TimelineItem } from "../core/types";
import { ChatController, type ModelOptionProvider, type ServerRequestCard } from "../app/controller";
import { Bubble } from "./Bubble";
import { Composer, screenDroppedFiles } from "./Composer";
import { HistoryPanel, type StoredSession } from "./HistoryPanel";
import { ModelPicker } from "./ModelPicker";
import { TabStrip } from "./TabStrip";
import { runningLabel } from "./format";
import type { HermesPluginSdk } from "./sdk";

interface ApprovalCardState extends ServerRequestCard {
  kind: "approval" | "clarify";
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
            className: "hb-pre hb-mt-sm p-2",
            style: {
              fontFamily: "var(--font-mono)",
              fontSize: "0.8125rem",
              background: "var(--color-background, color-mix(in oklab, var(--color-muted) 70%, transparent))",
              borderRadius: "calc(var(--radius) * 0.6)",
            },
          },
          String(card.params.command),
        )
      : null,
    React.createElement(
      "div",
      { className: "hb-stack-gap flex flex-wrap gap-2" },
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
  const questions =
    (card.params.questions as { qid: string; question: string; choices?: string[] }[] | undefined) ?? [];
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
              { className: "hb-mt-sm flex flex-wrap gap-2" },
              question.choices.map((choice) =>
                React.createElement(
                  "button",
                  {
                    key: choice,
                    type: "button",
                    className: "cursor-pointer px-2.5 py-1",
                    style: {
                      background: "var(--color-muted)",
                      color: "var(--color-card-foreground)",
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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [catalog, setCatalog] = useState<CommandEntry[]>([]);
  const [stored, setStored] = useState<StoredSession[]>([]);
  const [loadingStored, setLoadingStored] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [providers, setProviders] = useState<ModelOptionProvider[]>([]);
  const [modelChoice, setModelChoice] = useState({ model: "", provider: "" });
  const [reasoning, setReasoning] = useState("medium");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const timeline = activeTimeline(state);
  const running = runningKeys(state);

  // ── boot ────────────────────────────────────────────────────────────────
  useEffect(() => {
    controller.setServerRequestSink((card) => {
      setCards((prev) => [...prev, { ...card, kind: card.method === "approval" ? "approval" : "clarify" }]);
    });
    // `start()` waits for the socket before opening the session. Calling
    // `connect()` then `openSession()` races and reports "gateway not connected"
    // on a connection that succeeds a moment later.
    controller
      .start()
      .then(() => refreshStored())
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));

    // The command catalog is fetched once and filtered locally: typing `/` must
    // not wait on a round trip.
    controller
      .commandsCatalog()
      .then((raw) => setCatalog(entriesFromCatalog(raw as never)))
      .catch(() => setCatalog([]));

    return () => {
      controller.setServerRequestSink(null);
      controller.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);

  // Seed the pickers from the live session's own model once it is known.
  useEffect(() => {
    const meta = timeline.meta;
    if (meta.model) setModelChoice({ model: meta.model, provider: meta.provider });
    if (meta.reasoningEffort) setReasoning(meta.reasoningEffort);
  }, [timeline.meta.model, timeline.meta.provider, timeline.meta.reasoningEffort]);

  const refreshStored = useCallback(() => {
    setLoadingStored(true);
    controller
      .listSessions()
      .then((rows) => setStored(rows))
      .catch(() => setStored([]))
      .finally(() => setLoadingStored(false));
  }, [controller]);

  // ── transcript scroll ───────────────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [timeline.items.length, timeline.items.at(-1)]);

  // ── actions ─────────────────────────────────────────────────────────────

  const answer = useCallback((card: ApprovalCardState, choice: string) => {
    card.respond(card.kind === "approval" ? { choice } : { answers: choice as unknown as Record<string, string> });
    setCards((prev) => prev.filter((c) => c.id !== card.id));
  }, []);

  const answerClarify = useCallback((card: ApprovalCardState, answers: Record<string, string>) => {
    card.respond({ answers });
    setCards((prev) => prev.filter((c) => c.id !== card.id));
  }, []);

  const onSend = useCallback(
    (text: string) => {
      setError(null);
      controller
        .send(text)
        .then(() => setAttachments([]))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [controller],
  );

  const onStop = useCallback(() => {
    controller.interrupt().catch(() => undefined);
  }, [controller]);

  /**
   * Stage picked/dropped files.
   *
   * Each file is read to a data URL and pushed to the backend, which hands back
   * the `@file:` reference to insert. Rejections are surfaced as notices rather
   * than silently dropped — a file that vanishes with no explanation is the
   * worst outcome here.
   */
  const onPickFiles = useCallback(
    (files: FileList | File[]) => {
      const { accepted, rejected } = screenDroppedFiles(files);
      for (const item of rejected) controller.notice(`${item.name}：${item.reason}`, "error");
      for (const { file, id } of accepted) {
        const pending: Attachment = { id, kind: "file", name: file.name, size: file.size, status: "staging" };
        setAttachments((prev) => addAttachment(prev, pending));
        controller
          .attachFile(
            {
              name: file.name,
              type: file.type,
              size: file.size,
              dataUrl: () =>
                new Promise<string>((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(String(reader.result));
                  reader.onerror = () => reject(new Error("读取文件失败"));
                  reader.readAsDataURL(file);
                }),
            },
            id,
          )
          .then((done) => setAttachments((prev) => updateAttachment(prev, id, done)))
          .catch((err: unknown) =>
            setAttachments((prev) =>
              updateAttachment(prev, id, {
                status: "error",
                error: err instanceof Error ? err.message : String(err),
              }),
            ),
          );
      }
    },
    [controller],
  );

  const onRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => removeAttachment(prev, id));
  }, []);

  const openModelPicker = useCallback(() => {
    setPickerOpen(true);
    setPickerLoading(true);
    controller
      .listModels()
      .then((result) => {
        setProviders(result.providers);
        setModelChoice({ model: result.model, provider: result.provider });
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setPickerLoading(false));
  }, [controller]);

  const onPickModel = useCallback(
    (model: string, provider: string) => {
      setPickerOpen(false);
      setModelChoice({ model, provider });
      controller
        .setModel(model, provider, { sessionOnly: true })
        .then((result) => {
          if (result.confirmRequired) {
            controller.notice(result.confirmMessage || "这是一个较贵的模型，已取消切换", "error");
          } else if (result.deferred) {
            controller.notice("模型切换已排队，下一轮生效");
          }
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [controller],
  );

  const onPickReasoning = useCallback(
    (level: string) => {
      setReasoning(level);
      controller.setReasoning(level).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [controller],
  );

  const onCompletePath = useCallback((word: string) => controller.completePath(word), [controller]);

  const onOpenStored = useCallback(
    (id: string, title: string) => {
      controller
        .openStoredSession(id, title)
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [controller],
  );

  const onNew = useCallback(() => {
    controller.newSession().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [controller]);

  const tabs: readonly SessionTab[] = state.tabs;
  const activeStoredId = tabs.find((t) => t.key === state.activeKey)?.storedId ?? null;
  const status = runningLabel({ status: timeline.meta.status, running: timeline.meta.running });

  return React.createElement(
    "div",
    { className: "flex h-full min-h-0 flex-col" },

    // ── tabs ────────────────────────────────────────────────────────────
    React.createElement(TabStrip, {
      sdk,
      tabs,
      activeKey: state.activeKey,
      runningKeys: running,
      historyOpen,
      onFocus: (key: string) => controller.focusSession(key),
      onClose: (key: string) => controller.closeSession(key),
      onNew,
      onToggleHistory: () => setHistoryOpen((v: boolean) => !v),
    }),

    // ── transcript + history ────────────────────────────────────────────
    React.createElement(
      "div",
      { className: "flex min-h-0 flex-1" },

      React.createElement(
        "div",
        { className: "flex min-h-0 flex-1 flex-col" },
        React.createElement(
          "div",
          { className: "min-h-0 flex-1 overflow-y-auto px-4 py-4 hb-scroll" },
          React.createElement(
            "div",
            { className: "mx-auto flex flex-col gap-3", style: { maxWidth: "860px" } },
            timeline.items.length === 0
              ? React.createElement(
                  "div",
                  { className: "py-16 text-center text-sm", style: { color: "var(--color-muted-foreground)" } },
                  "开始一段对话。输入 / 唤起命令。",
                )
              : timeline.items.map((item: TimelineItem) =>
                  React.createElement(Bubble, { key: item.id, sdk, item }),
                ),
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
              ? React.createElement("div", { className: "text-xs", style: { color: "var(--color-destructive)" } }, error)
              : null,
            React.createElement("div", { ref: bottomRef }),
          ),
        ),

        React.createElement(Composer, {
          sdk,
          running: timeline.meta.running,
          status,
          connected: timeline.meta.connected,
          usage: timeline.meta.usage,
          model: modelChoice.model || timeline.meta.model,
          provider: modelChoice.provider || timeline.meta.provider,
          reasoning,
          attachments,
          catalog,
          onSend,
          onStop,
          onPickFiles,
          onRemoveAttachment,
          onOpenModelPicker: openModelPicker,
          onPickReasoning,
          onCompletePath,
          onError: setError,
        }),
      ),

      React.createElement(HistoryPanel, {
        sdk,
        open: historyOpen,
        sessions: stored,
        loading: loadingStored,
        activeStoredId,
        onOpen: onOpenStored,
        onRefresh: refreshStored,
        onClose: () => setHistoryOpen(false),
      }),
    ),

    React.createElement(ModelPicker, {
      sdk,
      open: pickerOpen,
      loading: pickerLoading,
      providers,
      currentModel: modelChoice.model || timeline.meta.model,
      currentProvider: modelChoice.provider || timeline.meta.provider,
      reasoning,
      onPick: onPickModel,
      onPickReasoning,
      onClose: () => setPickerOpen(false),
    }),
  );
}
