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

import { addAttachment, classifyFile, removeAttachment, updateAttachment, type Attachment, type MessageAttachment } from "../core/attachments";
import { cardsForTab, waitingKeys, withoutWithdrawn } from "../core/cards";
import { parseSessionDrop } from "../core/context";
import { messagesFor, type Locale } from "../core/i18n";
import { gitTargetDir, type GitInfo } from "../core/gitinfo";
import { followAfterChange, pinnedState, pinAfterScroll, type PinState } from "../core/pin";
import { entriesFromCatalog, type CommandEntry } from "../core/slash";
import { activeTimeline, runningKeys, type SessionTab } from "../core/sessions";
import type { TimelineItem } from "../core/types";
import {
  readStoredWorkspace,
  workspaceOptions,
  writeStoredWorkspace,
  type WorkspacesPayload,
} from "../core/workspaces";
import {
  hiddenProjectCount,
  projectRows,
  projectRemoval,
  readHiddenProjects,
  sessionsOfProject,
  visibleProjectRows,
  writeHiddenProjects,
  type ProjectNode,
  type ProjectSessionRow,
  type ProjectsTree,
} from "../core/projects";
import { ChatController, type ModelOptionProvider, type ServerRequestCard } from "../app/controller";
import { createControllerHolder } from "../app/persistent";
import { Bubble } from "./Bubble";
import { Composer, screenDroppedFiles } from "./Composer";
import { ConfirmDialog } from "./ConfirmDialog";
import { HistoryPanel, type HistoryMode, type StoredSession } from "./HistoryPanel";
import { LocatorRail } from "./LocatorRail";
import { ModelPicker } from "./ModelPicker";
import { ApprovalCard, ClarifyCard, approvalResult } from "./RequestCards";
import { TabStrip } from "./TabStrip";
import { TodoPanel } from "./TodoPanel";
import { Icon } from "./icons";
import { useMobile } from "./useMobile";
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

/** localStorage, or null when the browser refuses it (private mode / sandbox). */
function storageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The management profile this page is served under.
 *
 * The dashboard routes a non-default profile as `/p/<name>/chat`; the default
 * profile has no prefix. The workspace pick is stored per profile so two agents
 * driving different repos do not fight over one key.
 */
function currentProfile(): string {
  const match = /^\/p\/([^/]+)\//.exec(window.location.pathname);
  if (!match?.[1]) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

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
  const profile = currentProfile();
  return new ChatController({
    urlProvider: () => boundSdk!.buildWsUrl("/api/ws"),
    // The workspace is a preference, not session state: restore it here so the
    // very first `session.create` of this document already lands in the right
    // directory instead of needing a second chat to take effect.
    initialWorkspace: readStoredWorkspace(storageOrNull(), profile),
    persistWorkspace: (cwd) => writeStoredWorkspace(storageOrNull(), profile, cwd),
  });
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
  // Phone vs desktop. Two things below are not styles and cannot be CSS: the tab
  // strip is REPLACED by a drawer (its state is React state), and the composer
  // swaps its chips for a menu. Everything else stays in the media block.
  const mobile = useMobile(sdk);

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
  // A pick the gateway wants confirmed before it applies. Holds the pair to
  // re-send, so accepting the dialog repeats the exact switch the user made.
  const [pendingSwitch, setPendingSwitch] = useState<{
    model: string;
    provider: string;
    message: string;
  } | null>(null);
  const [reasoning, setReasoning] = useState("medium");
  // Workspace picker: the host's project/repo list, plus its own load state.
  // The pick itself lives in the controller (it has to survive a route change
  // and outlive the tab it was made in); this is only the option list.
  const [workspaces, setWorkspaces] = useState<WorkspacesPayload | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceFailed, setWorkspaceFailed] = useState(false);
  // Git badge beside the workspace chip: branch + working-tree state of the
  // chip's directory. `null` = not a repo, so nothing is rendered.
  const [git, setGit] = useState<GitInfo | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  /** Bumped to force a re-probe (manual click, or a turn that may have written files). */
  const [gitTick, setGitTick] = useState(0);
  // Dangerous-command approval mode (profile-wide). Read once on mount; the
  // chip writes it back through the controller.
  const [approvalMode, setApprovalModeValue] = useState("");
  // History panel: flat recents vs project grouping. The tree is fetched lazily
  // (its first read git-probes every distinct session cwd on the host).
  const [historyMode, setHistoryMode] = useState<HistoryMode>("recent");
  const [projectTree, setProjectTree] = useState<ProjectsTree | null>(null);
  // Auto-discovered repos the user hid from this list. Client-side by design:
  // `projects.delete` only knows explicit projects (see core/projects.ts), so
  // hiding is local state, keyed to the profile exactly like the workspace pick.
  const [hiddenProjects, setHiddenProjects] = useState<string[]>(() =>
    readHiddenProjects(storageOrNull(), currentProfile()),
  );
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsFailed, setProjectsFailed] = useState(false);
  const [projectSessionCache, setProjectSessionCache] = useState<
    Record<string, ProjectSessionRow[] | undefined>
  >({});
  const [loadingProjectId, setLoadingProjectId] = useState<string | null>(null);
  // Set while an existing user message is being rewritten: Send then truncates
  // and resubmits instead of appending.
  const [editing, setEditing] = useState<{ itemId: string; text: string } | null>(null);
  // One-shot text pushed into the composer (a history session pulled in as
  // context). `seq` is the identity: the composer applies each entry once.
  const [insertion, setInsertion] = useState<{ seq: number; text: string } | null>(null);
  const insertionSeq = useRef(0);
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
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // Whether the transcript is following new output. A ref, not state: it is
  // written from a scroll handler and read from a layout effect, and neither
  // should cost a render (see `core/pin.ts`).
  const pinRef = useRef<PinState>(pinnedState);

  // The boot effect must not re-run when the language changes, but the notice
  // sink needs the current language: keep it in a ref it reads at call time.
  const localeRef = useRef<Locale>(locale);

  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const timeline = activeTimeline(state);
  const running = runningKeys(state);
  // A socket carries every session's requests, so the flat card list is every
  // session's. Only the ones owning the focused transcript belong on screen:
  // drawing session A's question in session B is how answering it derailed B's
  // turn instead (see `core/cards.ts`).
  const visibleCards = cardsForTab(state, cards, state.activeKey);
  // Tabs that have a question waiting, for the strip's marker — the visible
  // signal that a background session needs you, without switching to it.
  const waiting = waitingKeys(state, cards);

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
    // A card whose request the backend withdrew must come off the screen, even
    // when the withdrawal arrived while this page was unmounted. Two frames mean
    // the same thing here (`request.cancel`, `approval.cancelled`); the
    // controller normalises both (see `core/cards.ts`).
    controller.setWithdrawalSink((withdrawal) => {
      setCards((prev) => withoutWithdrawn(prev, [withdrawal]));
    });
    // The controller decides *when* a turn ended or a request is pending; the
    // language and the browser permission are page concerns, so the page turns
    // one into the other. `maybeNotify` then applies the "only while in the
    // background" rule. The click handler jumps to the session that asked: with
    // several tabs open the notice is about ONE of them, and the reader was
    // probably not in it.
    controller.setNoticeSink((notice) =>
      maybeNotify(notice, localeRef.current, () => {
        if (notice.kind === "request" && notice.sessionKey) controller.focusSessionId(notice.sessionKey);
      }),
    );
    // Anything that asked while this page was unmounted (the user was on another
    // dashboard tab) is replayed now rather than having been refused.
    const parked = controller.takeParkedCards();
    if (parked.length) {
      setCards((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...parked.filter((c) => !seen.has(c.id))];
      });
    }
    // Withdrawals take precedence over whatever was parked: a request that was
    // both asked and cancelled while the page was away must not come back as a
    // live card.
    const withdrawn = controller.takeParkedWithdrawals();
    if (withdrawn.length) setCards((prev) => withoutWithdrawn(prev, withdrawn));
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
      controller.setWithdrawalSink(null);
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

  /**
   * Load the workspace list.
   *
   * Best effort on purpose: a dashboard whose projects.db cannot be read (or a
   * gateway that predates the endpoint) still has a usable chat page — the
   * picker then offers the default directory and a typed path.
   */
  const loadWorkspaces = useCallback(
    (scan: boolean) => {
      setWorkspaceLoading(true);
      return controller
        .listWorkspaces(scan)
        .then((payload) => {
          setWorkspaces(payload);
          setWorkspaceFailed(false);
        })
        .catch(() => setWorkspaceFailed(true))
        .finally(() => setWorkspaceLoading(false));
    },
    [controller],
  );

  useEffect(() => {
    void loadWorkspaces(false);
  }, [loadWorkspaces]);

  // Approval mode is profile-scoped config, not session state: read it once.
  useEffect(() => {
    let live = true;
    controller
      .getApprovalMode()
      .then((mode) => {
        if (live && mode) setApprovalModeValue(mode);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [controller]);

  const onApprovalModeChange = useCallback(
    (mode: string) => {
      const previous = approvalMode;
      setApprovalModeValue(mode); // optimistic
      controller.setApprovalMode(mode).catch((err: unknown) => {
        setApprovalModeValue(previous);
        setError(err instanceof Error ? err.message : String(err));
      });
    },
    [controller, approvalMode],
  );

  const wsOptions = useMemo(() => workspaceOptions(workspaces), [workspaces]);

  const onPickWorkspace = useCallback(
    (cwd: string) => {
      controller
        .pickWorkspace(cwd)
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [controller],
  );

  const onRescanWorkspaces = useCallback(() => {
    void loadWorkspaces(true);
  }, [loadWorkspaces]);

  // ── git badge (to the right of the workspace chip) ───────────────────────

  /**
   * The directory the chip and the git badge describe: the open chat's own cwd
   * when there is one (that is the "live" reading the picker is meant to show),
   * else the pick for the next new chat.
   */
  const gitDir = useMemo(
    () => gitTargetDir(timeline.meta.cwd, state.workspace, workspaces?.home ?? ""),
    [timeline.meta.cwd, state.workspace, workspaces?.home],
  );

  useEffect(() => {
    let live = true;
    if (!gitDir) {
      setGit(null);
      return () => {
        live = false;
      };
    }
    setGitLoading(true);
    controller
      .gitInfo(gitDir)
      // A failed probe is "no badge", not an error banner: the host may have no
      // git, or an older install may not carry the `/git` route.
      .catch(() => null)
      .then((info) => {
        if (live) setGit(info);
      })
      .finally(() => {
        if (live) setGitLoading(false);
      });
    return () => {
      live = false;
    };
  }, [controller, gitDir, gitTick]);

  const refreshGit = useCallback(() => setGitTick((tick) => tick + 1), []);

  // A finished turn is the moment the working tree changes: the agent may have
  // written files. Re-probe on the running → idle edge only, so a turn costs one
  // extra `git status` rather than one per streaming event.
  const wasRunning = useRef(false);
  useEffect(() => {
    const running = timeline.meta.running;
    if (wasRunning.current && !running) setGitTick((tick) => tick + 1);
    wasRunning.current = running;
  }, [timeline.meta.running]);

  // ── project grouping (history panel) ─────────────────────────────────────

  const loadProjects = useCallback(() => {
    setProjectsLoading(true);
    return controller
      .projectsTree()
      .then((tree) => {
        setProjectTree(tree);
        setProjectsFailed(false);
      })
      .catch(() => setProjectsFailed(true))
      .finally(() => setProjectsLoading(false));
  }, [controller]);

  // Lazy by design: the tree's first read resolves a git branch for every
  // distinct session cwd on the host, which is seconds on a big checkout. Paying
  // it when the tab is opened is fine; paying it on every page load is not.
  useEffect(() => {
    if (historyMode !== "projects" || projectTree !== null) return;
    void loadProjects();
  }, [historyMode, projectTree, loadProjects]);

  // Opening the list is the moment it has to be current: a session created (or
  // turned) since the last read is exactly what the user opened the drawer to
  // find, and the boot-time read is minutes old by then. Desktop gets this for
  // free because its panel is narrower than the eye's patience; the phone's
  // drawer is the only way to see the list at all.
  useEffect(() => {
    if (!historyOpen) return;
    void refreshStored();
  }, [historyOpen, refreshStored]);

  const loadProjectSessions = useCallback(
    (projectId: string) => {
      setLoadingProjectId(projectId);
      controller
        .projectSessions(projectId)
        .then((project) => {
          setProjectSessionCache((prev) => ({ ...prev, [projectId]: sessionsOfProject(project) }));
        })
        .catch(() => setProjectSessionCache((prev) => ({ ...prev, [projectId]: [] })))
        .finally(() => setLoadingProjectId((current) => (current === projectId ? null : current)));
    },
    [controller],
  );

  const projectRowsAll = useMemo(() => projectRows(projectTree), [projectTree]);
  // Two lists, one source: the rows to draw and the count behind "show hidden".
  // The count reads the UNFILTERED rows so a hidden entry that no longer matches
  // anything (a removed repo) does not advertise a restore that restores nothing.
  const projectViewRows = useMemo(
    () => visibleProjectRows(projectRowsAll, hiddenProjects),
    [projectRowsAll, hiddenProjects],
  );
  const hiddenProjectTotal = useMemo(
    () => hiddenProjectCount(projectRowsAll, hiddenProjects),
    [projectRowsAll, hiddenProjects],
  );

  const updateHiddenProjects = useCallback(
    (next: string[]) => {
      setHiddenProjects(next);
      writeHiddenProjects(storageOrNull(), currentProfile(), next);
    },
    [],
  );

  const onRenameProject = useCallback(
    (projectId: string, name: string) => {
      controller
        .renameProject(projectId, name)
        // The reply carries the refreshed `ProjectInfo`, not the tree it is drawn
        // from, so the label only changes after a re-read.
        .then(() => loadProjects())
        .catch((err: unknown) => {
          setError(`${t.projectRenameFailed}: ${err instanceof Error ? err.message : String(err)}`);
          // Roll back the optimistic label by re-reading what the backend has.
          void loadProjects();
        });
    },
    [controller, loadProjects, t],
  );

  /**
   * One row's "remove" action, in the two shapes the backend offers.
   *
   * An explicit project is deleted for real (`projects.delete`); an auto repo has
   * no row to delete, so it is hidden locally the way the desktop sidebar hides
   * it. The deletion answers the project list rather than the tree, so the tree
   * is re-read either way.
   */
  const onRemoveProject = useCallback(
    (project: ProjectNode) => {
      const kind = projectRemoval(project);
      if (kind === "none") return;
      if (kind === "hide") {
        updateHiddenProjects([...hiddenProjects, project.id]);
        return;
      }
      controller
        .deleteProject(project.id)
        .then(() => loadProjects())
        .catch((err: unknown) =>
          setError(`${t.projectRemoveFailed}: ${err instanceof Error ? err.message : String(err)}`),
        );
    },
    [controller, hiddenProjects, loadProjects, t, updateHiddenProjects],
  );

  const onRestoreHiddenProjects = useCallback(() => updateHiddenProjects([]), [updateHiddenProjects]);

  const onNewChatInProject = useCallback(
    (workspace: string) => {
      // Aim the next session at the project's folder, then open it: the same
      // preference the workspace chip writes, so the chip's label follows.
      controller.setWorkspace(workspace);
      controller
        .newSession()
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [controller],
  );

  // ── transcript scroll ───────────────────────────────────────────────────
  // Follow the bottom only while the reader is at the bottom. The pin tracks
  // the reader's own `scrollTop` (see `core/pin.ts`): a streaming turn appends
  // many times a second, and an unconditional `scrollIntoView` on each one made
  // it impossible to scroll up and read earlier output — every delta dragged
  // the view back down.

  /** Put the newest content in view and re-arm the follow. */
  const stickToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // The position, not `bottomRef.scrollIntoView`: the latter also scrolls
    // scrollable ancestors and drags the whole dashboard with it.
    pinRef.current = { lastTop: el?.scrollTop ?? 0, released: false };
  }, []);

  // A different session is a different transcript: open it at its newest output.
  React.useLayoutEffect(() => {
    stickToBottom();
  }, [state.activeKey, stickToBottom]);

  React.useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const next = followAfterChange(
      { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
      pinRef.current,
    );
    pinRef.current = next.state;
    if (next.decision === "follow") el.scrollTop = el.scrollHeight;
    // Keyed on the tail of the transcript, not on the whole items array: a
    // streaming delta replaces the last item, so growth at the end is caught,
    // while a status change on an older card must not drag the view (the reader
    // may be reading that card, or one the click just expanded). A duplicate
    // dropped by dedupe never reaches here at all. `visibleCards` rather than
    // `cards`: a question raised in ANOTHER session must not move this view —
    // before the filter existed it did exactly that in every open tab.
  }, [timeline.items.length, timeline.items.at(-1), visibleCards.length]);

  // ── actions ─────────────────────────────────────────────────────────────

  /** Drop a card once it is answered; the backend has it from here. */
  const retire = useCallback((id: string) => {
    setCards((prev) => prev.filter((card) => card.id !== id));
  }, []);

  const onSend = useCallback(
    (text: string, attachments: readonly MessageAttachment[] = []) => {
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
      // Sending is a deliberate "show me the answer": re-arm the follow even if
      // the reader had scrolled up into the history first.
      stickToBottom();
      const run = target
        ? controller.editAndResend(target.itemId, text)
        : controller.send(text, attachments);
      run
        .then(() => {
          // The bubble already holds its own snapshot of these, so the object
          // URLs are not revoked here: revoking would blank the thumbnails the
          // transcript is still drawing.
          setAttachments([]);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    },
    [controller, editing, notifyState, stickToBottom],
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
   * Refresh THIS chat, not the browser page.
   *
   * Re-reads the focused session's durable transcript (`session.history`) and
   * the stored-session list, which is what repairs a transcript that drifted —
   * a missed event, a phone that slept through the stream, or a turn that
   * finished in another window. `location.reload()` would work too but throws
   * away every other open tab and the socket. The phone has this as a floating
   * button because mobile browsers hide the real refresh control, and the
   * dashboard's own chrome is a hamburger away.
   */
  const refreshChat = useCallback(
    () =>
      controller
        .resync()
        .then(() => {
          refreshStored();
          refreshGit();
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))),
    [controller, refreshStored, refreshGit],
  );

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
        // A local object URL for the thumbnail. It lives as long as the page
        // does: the staging tray and the sent bubble both point at it, and a
        // long conversation would have to reclaim it explicitly to be worth the
        // bookkeeping.
        const previewUrl = file.type.startsWith("image/") || file.type.startsWith("video/")
          ? URL.createObjectURL(file)
          : undefined;
        const pending: Attachment = {
          id,
          kind: classifyFile(file.name, file.type),
          name: file.name,
          size: file.size,
          status: "staging",
          phase: "reading",
          readProgress: 0,
          previewUrl,
        };
        setAttachments((prev) => addAttachment(prev, pending));
        controller
          .attachFile(
            {
              name: file.name,
              type: file.type,
              size: file.size,
              // `readAsDataURL` reports no progress, so the read is chunked into
              // the same base64 shape by hand — over a remote dashboard this is
              // where the seconds go for a large file, and a spinner with no
              // number reads as "stuck".
              dataUrl: (onRead) => readAsDataUrl(file, onRead),
            },
            id,
            (patch) => setAttachments((prev) => updateAttachment(prev, id, patch)),
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

  /**
   * Send a pick, then either report it or ask the user to confirm it.
   *
   * `confirm_required` is not a failure and not an applied switch: the gateway
   * wrote nothing and will only move when the SAME pick comes back with
   * `confirm_expensive_model: true`. Showing that message as a notice (the old
   * behaviour) left no way to say yes, so a long-context switch could not be
   * completed at all. `modelChoice` is therefore only updated once the reply is
   * not a confirmation request — otherwise the composer would label itself with
   * a model the session is not on.
   */
  const applyModel = useCallback(
    (model: string, provider: string, confirmed: boolean) => {
      controller
        .setModel(model, provider, { sessionOnly: true, confirmExpensive: confirmed })
        .then((result) => {
          if (result.confirmRequired) {
            setPendingSwitch({
              model,
              provider,
              message: result.confirmMessage || t.modelConfirmFallback,
            });
            return;
          }
          setPendingSwitch(null);
          setModelChoice({ model, provider });
          if (result.deferred) controller.notice(t.modelQueued);
        })
        .catch((err: unknown) => {
          setPendingSwitch(null);
          setError(err instanceof Error ? err.message : String(err));
        });
    },
    [controller, t],
  );

  const onPickModel = useCallback(
    (model: string, provider: string) => {
      setPickerOpen(false);
      applyModel(model, provider, false);
    },
    [applyModel],
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

  /**
   * Pull a stored session's transcript into the composer as context.
   *
   * Read-only on the backend (`session.history`), so it never makes that row the
   * active session. A session with no prose (tool-only, or freshly created)
   * reports that instead of inserting a bare header.
   */
  const onUseAsContext = useCallback(
    (id: string, title: string) => {
      controller
        .contextForStoredSession(id, title)
        .then((block) => {
          if (!block.text) {
            setError(t.contextEmpty);
            return;
          }
          insertionSeq.current += 1;
          setInsertion({ seq: insertionSeq.current, text: block.text });
        })
        .catch((err: unknown) =>
          setError(t.contextFailed(err instanceof Error ? err.message : String(err))),
        );
    },
    [controller, t],
  );

  /** A history row dropped on the composer carries `{id, title}`. */
  const onDropSession = useCallback(
    (payload: string) => {
      const ref = parseSessionDrop(payload);
      if (ref) onUseAsContext(ref.id, ref.title);
    },
    [onUseAsContext],
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
    { className: "flex h-full min-h-0 flex-col", "data-layout": mobile ? "mobile" : "desktop" },

    // ── tabs, or the phone's two floating buttons ───────────────────────
    // The strip is not restyled on a phone, it is REPLACED: one horizontal bar
    // of tabs plus a history toggle costs ~40px of a 640px viewport and has no
    // room for the two actions that matter there. Instead two 40px round
    // buttons float over the transcript — refresh on the left (the chat's data,
    // not the browser page), the drawer handle on the right.
    mobile
      ? React.createElement(
          "div",
          { className: "hb-fab-row", "data-hb": "fab-row" },
          React.createElement(
            "button",
            {
              type: "button",
              "data-hb": "refresh-chat",
              className: "hb-fab",
              title: t.refreshChat,
              "aria-label": t.refreshChat,
              onClick: () => void refreshChat(),
            },
            Icon(sdk, { name: "refresh", size: 17 }),
          ),
          React.createElement(
            "button",
            {
              type: "button",
              "data-hb": "drawer-toggle",
              "data-open": historyOpen ? "true" : "false",
              className: "hb-fab",
              title: t.chatMenu,
              "aria-label": t.chatMenu,
              "aria-expanded": historyOpen,
              onClick: () => setHistoryOpen((v: boolean) => !v),
            },
            Icon(sdk, { name: "dots", size: 18 }),
            // A waiting request on a background session must still be visible
            // with no tab strip to mark it.
            waiting.length
              ? React.createElement("span", {
                  className: "hb-fab-badge",
                  "data-hb": "tab-waiting",
                  title: t.waitingForAnswer,
                  "aria-label": t.waitingForAnswer,
                })
              : null,
            running.length
              ? React.createElement("span", { className: "hb-fab-dot", "aria-hidden": "true" })
              : null,
          ),
        )
      : React.createElement(TabStrip, {
          sdk,
          locale,
          tabs,
          activeKey: state.activeKey,
          runningKeys: running,
          waitingKeys: waiting,
          historyOpen,
          notifyState,
          onToggleNotify,
          onFocus: (key: string) => controller.focusSession(key),
          onClose: (key: string) => controller.closeSession(key),
          onNew,
          onToggleHistory: () => setHistoryOpen((v: boolean) => !v),
        }),

    // ── transcript + history ────────────────────────────────────────────
    // `min-w-0` on every flex item in this chain: a flex item defaults to
    // `min-width:auto`, i.e. it refuses to shrink below its content's
    // min-content width. One long code line or unbreakable token then blows the
    // whole chat column out to ~900px on a 390px phone — the transcript renders
    // past both edges and the host's `overflow:hidden` clips it with no way to
    // scroll. `min-w-0` lets the column shrink to the viewport and pushes the
    // overflow down into the code block's own scroller.
    React.createElement(
      "div",
      { className: "flex min-h-0 min-w-0 flex-1" },

      React.createElement(
        "div",
        { className: "flex min-h-0 min-w-0 flex-1 flex-col" },
        React.createElement(
          "div",
          { className: "relative flex min-h-0 min-w-0 flex-1" },
        React.createElement(
          "div",
          {
            className: "min-h-0 flex-1 overflow-y-auto px-4 py-4 hb-scroll",
            ref: scrollerRef,
            // The reader's own scrolling is the only signal for "stop following
            // the stream" — see `core/pin.ts` for why position alone is not.
            onScroll: (event: { currentTarget: HTMLDivElement }) => {
              const el = event.currentTarget;
              pinRef.current = pinAfterScroll(
                { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
                pinRef.current,
              );
            },
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
            visibleCards.map((card) =>
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
          mobile,
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
          notifyState,
          onToggleNotify,
          onSend,
          onStop,
          onPickFiles,
          onRemoveAttachment,
          onOpenModelPicker: openModelPicker,
          onPickReasoning,
          onError: setError,
          insertion,
          onDropSession,
          workspace: state.workspace,
          workspaceCurrent: timeline.meta.cwd,
          workspaceOptions: wsOptions,
          workspaceHome: workspaces?.home ?? "",
          workspaceLoading,
          workspaceFailed,
          git,
          gitLoading,
          onRefreshGit: refreshGit,
          onPickWorkspace,
          onRescanWorkspaces,
          approvalMode,
          onApprovalModeChange,
        }),
      ),

      React.createElement(HistoryPanel, {
        sdk,
        locale,
        open: historyOpen,
        variant: mobile ? "drawer" : "panel",
        mode: historyMode,
        onModeChange: setHistoryMode,
        onRefreshProjects: () => {
          void loadProjects();
        },
        projectView: {
          rows: projectViewRows,
          loading: projectsLoading,
          failed: projectsFailed,
          activeStoredId,
          openStoredIds: tabs.map((tab) => tab.storedId).filter((id): id is string => Boolean(id)),
          busyStoredIds: tabs
            .filter((tab) => running.includes(tab.key))
            .map((tab) => tab.storedId)
            .filter((id): id is string => Boolean(id)),
          sessionCache: projectSessionCache,
          loadingProjectId,
          hiddenCount: hiddenProjectTotal,
          onExpand: loadProjectSessions,
          onOpen: (id: string) => onOpenStored(id, ""),
          onNewChat: onNewChatInProject,
          onRename: onRenameProject,
          onRemove: onRemoveProject,
          onRestoreHidden: onRestoreHiddenProjects,
        },
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
        onUseAsContext,
        onClose: () => setHistoryOpen(false),
        onNew,
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

    pendingSwitch
      ? React.createElement(ConfirmDialog, {
          sdk,
          title: t.modelConfirmTitle,
          message: pendingSwitch.message,
          acceptLabel: t.modelConfirmAccept,
          cancelLabel: t.cancel,
          onAccept: () => applyModel(pendingSwitch.model, pendingSwitch.provider, true),
          onCancel: () => setPendingSwitch(null),
        })
      : null,
  );
}

/**
 * Read a File into a base64 data URL, reporting progress.
 *
 * `FileReader.readAsDataURL` is the obvious call, but it only fires `progress`
 * for some backings and never tells you the final size on a blob URL. Reading
 * in slices through `arrayBuffer()` is a few lines, works everywhere, and gives
 * a real fraction — which is the difference between "uploading…" and an
 * apparently frozen chip on a phone over a slow link.
 */
function readAsDataUrl(file: File, onProgress?: (fraction: number) => void): Promise<string> {
  const CHUNK = 512 * 1024;
  const total = file.size || 1;
  if (file.size <= CHUNK) {
    return file.arrayBuffer().then((buffer) => {
      onProgress?.(1);
      return dataUrlOf(buffer, file.type);
    });
  }
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const next = (): Promise<string> => {
    const end = Math.min(offset + CHUNK, file.size);
    return file.slice(offset, end).arrayBuffer().then((buffer) => {
      chunks.push(new Uint8Array(buffer));
      offset = end;
      onProgress?.(Math.min(1, offset / total));
      if (offset < file.size) return next();
      const joined = new Uint8Array(file.size);
      let at = 0;
      for (const chunk of chunks) {
        joined.set(chunk, at);
        at += chunk.byteLength;
      }
      return dataUrlOf(joined.buffer, file.type);
    });
  };
  return next();
}

function dataUrlOf(buffer: ArrayBuffer, type: string): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunked so `String.fromCharCode` never sees an argument list long enough to
  // overflow the stack on a multi-megabyte file.
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return `data:${type || "application/octet-stream"};base64,${btoa(binary)}`;
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
