/**
 * The page: tab strip on top, transcript in the middle, history panel on the
 * right, composer at the bottom.
 *
 * This is what the registry mounts at `/chat`. It owns a `ChatController` and
 * re-renders from it through `useSyncExternalStore`, so a streaming turn costs
 * one render per event batch and nothing re-renders that did not change.
 *
 * Everything with a decision in it lives in `core/` or the controller; this file
 * is wiring and the state that is genuinely view-local (request cards on screen,
 * the model picker's open flag, the history panel's collapsed state).
 */

import { addAttachment, removeAttachment, updateAttachment, type Attachment } from "../core/attachments";
import { messagesFor, type Locale } from "../core/i18n";
import { entriesFromCatalog, type CommandEntry } from "../core/slash";
import { activeTimeline, runningKeys, type SessionTab } from "../core/sessions";
import type { TimelineItem } from "../core/types";
import { ChatController, type ModelOptionProvider, type ServerRequestCard } from "../app/controller";
import { createControllerHolder } from "../app/persistent";
import { Bubble } from "./Bubble";
import { Composer, screenDroppedFiles } from "./Composer";
import { HistoryPanel, type StoredSession } from "./HistoryPanel";
import { LocatorRail } from "./LocatorRail";
import { ModelPicker } from "./ModelPicker";
import { ApprovalCard, ClarifyCard, approvalResult } from "./RequestCards";
import { TabStrip } from "./TabStrip";
import { TodoPanel } from "./TodoPanel";
import {
  maybeNotify,
  notificationPermission,
  notifyEnabled,
  raiseTestNotification,
  requestNotificationPermission,
  setNotifyEnabled,
} from "./notifier";
import { notifySwitch, type NotificationPermissionKind } from "../core/notify";
import { rejectionLabel, runningLabel } from "./format";
import { useLocale } from "./useLocale";
import type { HermesPluginSdk } from "./sdk";

let boundSdk: HermesPluginSdk | null = null;

/**
 * The chat controller for this document.
 *
 * Module scope, not component scope: the dashboard unmounts this page when you
 * switch to another dashboard tab, and a per-mount controller took the socket
 * and every open session down with it. The SDK is captured on first mount (a
 * document has exactly one).
 */
const chatController = createControllerHolder<ChatController>(() => {
  if (!boundSdk) throw new Error("hermes-bubbles: controller acquired before the page mounted");
  return new ChatController({ urlProvider: () => boundSdk!.buildWsUrl("/api/ws") });
});

function acquireController(sdk: HermesPluginSdk): ChatController {
  boundSdk = sdk;
  return chatController.acquire();
}

export function ChatPage({ sdk }: { sdk: HermesPluginSdk }) {
  const { React } = sdk;
  const { useCallback, useEffect, useMemo, useRef, useState } = sdk.hooks;
  // `useSyncExternalStore` is NOT in the SDK's curated hooks map — take it off
  // the React instance itself. Verified against SDK_CONTRACT_VERSION 1.1.0.
  const useSyncExternalStore = React.useSyncExternalStore;

  const locale: Locale = useLocale(sdk);
  const t = messagesFor(locale);

  // Module-level so a route change (which unmounts this page) does not tear down
  // the socket and the open tabs. See `app/persistent.ts`.
  const controller = useMemo(() => acquireController(sdk), [sdk]);

  const [cards, setCards] = useState<ServerRequestCard[]>([]);
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
  // Set while an existing user message is being rewritten: Send then truncates
  // and resubmits instead of appending.
  const [editing, setEditing] = useState<{ itemId: string; text: string } | null>(null);
  // Desktop notifications: the switch is persisted, the permission is the
  // browser's, and the two are independent (a blocked browser keeps the switch
  // on but nothing fires).
  const [notifyOn, setNotifyOn] = useState<boolean>(() => notifyEnabled());
  const [notifyPermission, setNotifyPermission] = useState<NotificationPermissionKind>(() =>
    notificationPermission(),
  );
  // Preference AND permission: the switch must not read "on" in a browser that
  // has never granted permission, which is the state where nothing can fire.
  const notifyState = notifySwitch(notifyOn, notifyPermission);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // The boot effect must not re-run when the language changes, but the notice
  // sink needs the current language: keep it in a ref it reads at call time.
  const localeRef = useRef<Locale>(locale);

  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const timeline = activeTimeline(state);
  const running = runningKeys(state);

  // The controller emits a few strings of its own (notices, errors); keep its
  // locale in step with what is on screen.
  useEffect(() => {
    controller.setLocale(locale);
    localeRef.current = locale;
  }, [controller, locale]);

  // Stored-session rename/delete go through REST, and the only auth-aware
  // fetcher is the SDK's — a bare `fetch` 401s against this server.
  useEffect(() => {
    controller.setHttpFetcher((path, init) => sdk.fetchJSON(path, init));
    return () => controller.setHttpFetcher(null);
  }, [controller, sdk]);

  // ── boot ────────────────────────────────────────────────────────────────
  useEffect(() => {
    controller.setServerRequestSink((card) => {
      setCards((prev) => (prev.some((c) => c.id === card.id) ? prev : [...prev, card]));
    });
    // The controller decides *when* a turn ended or a request is pending; the
    // language and the browser permission are page concerns, so the page turns
    // one into the other. `maybeNotify` then applies the "only while in the
    // background" rule.
    controller.setNoticeSink((notice) => maybeNotify(notice, localeRef.current));
    // Anything that asked while this page was unmounted (the user was on another
    // dashboard tab) is replayed now rather than having been refused.
    const parked = controller.takeParkedCards();
    if (parked.length) {
      setCards((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...parked.filter((c) => !seen.has(c.id))];
      });
    }
    // `start()` waits for the socket before opening the session. Calling
    // `connect()` then `openSession()` races and reports "gateway not connected"
    // on a connection that succeeds a moment later.
    // Safe to call on every mount: `start()` reconnects only if the socket is
    // closed and leaves an existing tab list alone.
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
      // The notice sink deliberately stays: the controller outlives this page
      // (see `persistent.ts`), so a turn that finishes while the user is on
      // another dashboard route still rings the desktop. `maybeNotify` is
      // module-level and touches only `window`/`document`, never React state,
      // so leaving it registered after unmount is safe — and clearing it here is
      // what made notifications work only while the chat page was on screen.
      // Release the reference only. Disposing here is what closed the socket on
      // every route change and lost the open sessions.
      chatController.release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);

  // The permission can change outside this page: granted from the site-settings
  // panel, revoked there too, or accepted in the browser's own prompt while the
  // window was elsewhere. Re-read it when the page comes back, so the switch
  // stops claiming a state the browser no longer agrees with.
  useEffect(() => {
    const sync = () => setNotifyPermission(notificationPermission());
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

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

  /** Drop a card once it is answered; the backend has it from here. */
  const retire = useCallback((id: string) => {
    setCards((prev) => prev.filter((card) => card.id !== id));
  }, []);

  const onSend = useCallback(
    (text: string) => {
      setError(null);
      // A send is a user gesture — a legitimate moment to ask the browser for
      // notification permission, for a user who has the switch on and never
      // clicked it. A granted prompt fires the confirmation toast, so the answer
      // arrives visibly instead of silently.
      if (notifyState === "needs-permission") {
        void requestNotificationPermission().then((permission) => {
          setNotifyPermission(permission);
          if (permission === "granted") raiseTestNotification(localeRef.current);
        });
      }
      const target = editing;
      setEditing(null);
      const run = target ? controller.editAndResend(target.itemId, text) : controller.send(text);
      run
        .then(() => setAttachments([]))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
        },
        [controller, editing, notifyState],
        );

  /**
   * The switch, per state.
   *
   * "on" → off. "off" → on, and ask the browser. "needs-permission" → the
   * preference is already on, so the useful click is the permission prompt
   * itself, followed by a real toast as proof. "blocked" → nothing this page can
   * do (browsers never re-prompt); the click turns the preference off so the
   * switch stops claiming an intent the browser will not honour.
   */
  const onToggleNotify = useCallback(() => {
    if (notifyState === "on" || notifyState === "blocked") {
      setNotifyEnabled(false);
      setNotifyOn(false);
      return;
    }
    setNotifyEnabled(true);
    setNotifyOn(true);
    void requestNotificationPermission().then((permission) => {
      setNotifyPermission(permission);
      if (permission === "granted") raiseTestNotification(localeRef.current);
    });
  }, [notifyState]);

  /** Start editing a sent message: put its text in the composer. */
  const onEdit = useCallback((itemId: string, text: string) => {
    setError(null);
    setEditing({ itemId, text });
  }, []);

  const onStop = useCallback(() => {
    controller.interrupt().catch(() => undefined);
  }, [controller]);

  /**
   * Stage picked/dropped files.
   *
   * Each file is read to a data URL and pushed to the backend, which queues it
   * for the next turn. Rejections are surfaced as notices rather than silently
   * dropped — a file that vanishes with no explanation is the worst outcome here.
   */
  const onPickFiles = useCallback(
    (files: FileList | File[]) => {
      const { accepted, rejected } = screenDroppedFiles(files);
      for (const item of rejected) controller.notice(`${item.name}: ${rejectionLabel(item, t)}`, "error");
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
                  reader.onerror = () => reject(new Error(t.fileReadFailed));
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
    [controller, t],
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
          if (result.confirmRequired) controller.notice(result.confirmMessage || t.cheapModelConfirm, "error");
          else if (result.deferred) controller.notice(t.modelQueued);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [controller, t],
  );

  const onPickReasoning = useCallback(
    (level: string) => {
      setReasoning(level);
      controller
        .setReasoning(level)
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [controller],
  );

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

  const onRename = useCallback(
    (id: string, title: string) => {
      controller
        .renameStoredSession(id, title)
        .then(() => refreshStored())
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [controller, refreshStored],
  );

  const onDelete = useCallback(
    (id: string) => {
      controller
        .deleteStoredSession(id)
        .then(() => refreshStored())
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [controller, refreshStored],
  );

  // ── per-message actions ─────────────────────────────────────────────────

  const onCopy = useCallback((text: string) => {
    // `navigator.clipboard` needs a secure context; the dashboard is http on
    // localhost, which counts, but a sandboxed frame can still refuse. Fall back
    // to a throwaway textarea so copy keeps working rather than reporting failure.
    const write = navigator.clipboard?.writeText(text);
    if (write) write.catch(() => fallbackCopy(text));
    else fallbackCopy(text);
  }, []);

  const onRegenerate = useCallback(
    (itemId: string) => {
      controller
        .regenerateAssistant(itemId)
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [controller],
  );

  const onBranch = useCallback(
    (itemId: string) => {
      controller
        .branchSession(itemId)
        .then(() => refreshStored())
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [controller, refreshStored],
  );

  const tabs: readonly SessionTab[] = state.tabs;
  const activeStoredId = tabs.find((t2) => t2.key === state.activeKey)?.storedId ?? null;
  // With no tab open the active timeline is an empty placeholder whose
  // `connected` is false — which would disable the composer and leave a closed
  // dashboard with a dead input box. The SOCKET is what decides whether input is
  // possible, not whether a tab happens to be focused.
  const socketOpen = controller.getConnection().state === "open";
  const composerConnected = tabs.length === 0 ? socketOpen : timeline.meta.connected;
  const status = runningLabel(timeline.meta, t);

  return React.createElement(
    "div",
    { className: "flex h-full min-h-0 flex-col" },

    // ── tabs ────────────────────────────────────────────────────────────
    React.createElement(TabStrip, {
      sdk,
      locale,
      tabs,
      activeKey: state.activeKey,
      runningKeys: running,
      historyOpen,
      notifyState,
      onToggleNotify,
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
          { className: "relative flex min-h-0 flex-1" },
        React.createElement(
          "div",
          {
            className: "min-h-0 flex-1 overflow-y-auto px-4 py-4 hb-scroll",
            ref: scrollerRef,
            "data-hb": "transcript",
          },
          React.createElement(
            "div",
            { className: "mx-auto flex flex-col", style: { maxWidth: "860px" } },
            timeline.items.length === 0
              ? React.createElement(
                  "div",
                  { className: "py-16 text-center text-sm", style: { color: "var(--color-muted-foreground)" } },
                  t.empty,
                )
              : timeline.items.map((item: TimelineItem) =>
                  React.createElement(
                    "div",
                    {
                      key: item.id,
                      className: "hb-bubble-gap",
                      // Per-kind vertical rhythm: messages breathe, tool rows and
                      // thinking blocks pack (see style.css).
                      "data-hb-kind": item.kind,
                      // Anchor for the locator rail's scroll-to.
                      "data-hb-item": item.id,
                    },
                    React.createElement(Bubble, {
                      sdk,
                      item,
                      locale,
                      onEdit,
                      onBranch,
                      onRegenerate,
                      onCopy,
                    }),
                  ),
                ),
            cards.map((card) =>
              React.createElement(
                "div",
                { key: card.id, className: "hb-bubble-gap" },
                card.method === "approval"
                  ? React.createElement(ApprovalCard, {
                      sdk,
                      card,
                      locale,
                      onAnswer: (choice) => {
                        card.respond(approvalResult(choice));
                        retire(card.id);
                      },
                    })
                  : React.createElement(ClarifyCard, {
                      sdk,
                      card,
                      locale,
                      onSubmit: (result) => {
                        card.respond(result);
                        retire(card.id);
                      },
                    }),
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
        React.createElement(LocatorRail, {
          sdk,
          locale,
          items: timeline.items,
          scrollerRef,
        }),
        ),

        // The task list sits directly above the composer: it describes what the
        // running turn is doing, and that is where the eye already is.
        timeline.meta.todo
          ? React.createElement(
              "div",
              { className: "px-4", style: { paddingBottom: "0.375rem" } },
              React.createElement(
                "div",
                { className: "mx-auto", style: { maxWidth: "860px" } },
                React.createElement(TodoPanel, { sdk, locale, todo: timeline.meta.todo }),
              ),
            )
          : null,

        React.createElement(Composer, {
          sdk,
          locale,
          editingText: editing?.text ?? null,
          onCancelEdit: () => setEditing(null),
          running: timeline.meta.running,
          status,
          connected: composerConnected,
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
          onError: setError,
        }),
      ),

      React.createElement(HistoryPanel, {
        sdk,
        locale,
        open: historyOpen,
        sessions: stored,
        loading: loadingStored,
        activeStoredId,
        // Every open tab's stored id feeds the lamp; `running` decides pulse.
        openStoredIds: tabs.map((tab) => tab.storedId).filter((id): id is string => Boolean(id)),
        busyStoredIds: tabs
          .filter((tab) => running.includes(tab.key))
          .map((tab) => tab.storedId)
          .filter((id): id is string => Boolean(id)),
        onOpen: onOpenStored,
        onRefresh: refreshStored,
        onRename,
        onDelete,
        onClose: () => setHistoryOpen(false),
      }),
    ),

    React.createElement(ModelPicker, {
      sdk,
      locale,
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

/**
 * Copy without the Clipboard API.
 *
 * `document.execCommand("copy")` is deprecated but is the only path left in a
 * frame that denies `navigator.clipboard`, and a message that cannot be copied
 * at all is worse than one copied through a deprecated call.
 */
function fallbackCopy(text: string): void {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  } catch {
    // Nothing else to try; the text is still selectable by hand.
  }
}
