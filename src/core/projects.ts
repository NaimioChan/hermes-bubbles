/**
 * Project grouping for the history panel.
 *
 * Pure projection over the backend's `projects.tree` / `projects.project_sessions`
 * payloads (the same tree the desktop sidebar renders): it decides row order,
 * which sessions belong to a project, and which directory a project's "new chat
 * here" button should aim at. No DOM, no RPC — those live in the controller.
 *
 * Two layers on purpose: project → sessions. The backend's third layer (branch /
 * worktree / kanban lanes) is collapsed away — this plugin does not drive
 * worktrees, and a lane header per branch would be a third indentation level for
 * no decision the user makes here.
 */

export interface ProjectSessionRow {
  id: string;
  title?: string;
  preview?: string;
  started_at?: number;
  last_active?: number;
  message_count?: number;
  cwd?: string | null;
  /** Present on rows the backend marks active (rarely set on a tree read). */
  is_active?: boolean;
}

export interface ProjectLane {
  id?: string;
  label?: string;
  sessions?: ProjectSessionRow[];
}

export interface ProjectRepo {
  id?: string;
  label?: string;
  path?: string | null;
  groups?: ProjectLane[];
  sessionCount?: number;
}

export interface ProjectNode {
  id: string;
  label: string;
  path?: string | null;
  color?: string | null;
  icon?: string | null;
  isAuto?: boolean;
  /** The synthetic bucket for sessions no project claimed (no cwd, deleted workspace). */
  isNoProject?: boolean;
  sessionCount?: number;
  lastActive?: number;
  repos?: ProjectRepo[];
  previewSessions?: ProjectSessionRow[];
  sessionIds?: string[];
}

export interface ProjectsTree {
  projects?: ProjectNode[];
  active_id?: string | null;
  scoped_session_ids?: string[];
}

/** The synthetic "no project" bucket id (mirrors `project_tree.NO_PROJECT_ID`). */
export const NO_PROJECT_ID = "__no_project__";

export interface ProjectRow {
  project: ProjectNode;
  /** Sessions to show without a drill-in (the preview the tree already carries). */
  preview: ProjectSessionRow[];
  /** Directory "new chat here" should use; "" when the project has no usable path. */
  workspace: string;
}

/** Newest first; the Home bucket always sinks to the bottom. */
export function projectRows(tree: ProjectsTree | null | undefined): ProjectRow[] {
  const projects = [...(tree?.projects ?? [])];
  const rows = projects.map((project) => ({
    project,
    preview: [...(project.previewSessions ?? [])],
    workspace: projectWorkspacePath(project),
  }));
  rows.sort((a, b) => {
    if (Boolean(a.project.isNoProject) !== Boolean(b.project.isNoProject)) {
      return a.project.isNoProject ? 1 : -1;
    }
    const byActive = (b.project.lastActive ?? 0) - (a.project.lastActive ?? 0);
    if (byActive !== 0) return byActive;
    return a.project.label.localeCompare(b.project.label);
  });
  return rows;
}

/**
 * The directory a project's "new chat here" should start in.
 *
 * A multi-folder project uses the folder it is anchored on: `path` when the
 * backend filled it, else the first repo's path. Empty for the Home bucket —
 * there is nothing to aim at, so the button must not be offered.
 */
export function projectWorkspacePath(project: ProjectNode): string {
  if (project.isNoProject) return "";
  const direct = (project.path ?? "").trim();
  if (direct) return direct;
  for (const repo of project.repos ?? []) {
    const path = (repo.path ?? "").trim();
    if (path) return path;
  }
  return "";
}

/**
 * Every session in a hydrated project, newest first, deduped by stored id.
 *
 * Lanes overlap on purpose in the backend's model (a session can appear under a
 * repo and its branch lane), so the caller gets one row per session rather than
 * one per placement.
 */
export function sessionsOfProject(project: ProjectNode | null | undefined): ProjectSessionRow[] {
  if (!project) return [];
  const byId = new Map<string, ProjectSessionRow>();
  const push = (row: ProjectSessionRow | undefined) => {
    if (!row?.id) return;
    const existing = byId.get(row.id);
    if (existing) {
      // Keep the copy that carries more fields.
      byId.set(row.id, { ...existing, ...Object.fromEntries(Object.entries(row).filter(([, v]) => v != null)) });
      return;
    }
    byId.set(row.id, row);
  };
  for (const repo of project.repos ?? []) {
    for (const lane of repo.groups ?? []) {
      for (const session of lane.sessions ?? []) push(session);
    }
  }
  for (const session of project.previewSessions ?? []) push(session);
  const rows = [...byId.values()];
  rows.sort((a, b) => lastActiveOf(b) - lastActiveOf(a));
  return rows;
}

/** Sort key: `last_active` when the backend sent it, else `started_at`, in seconds. */
export function lastActiveOf(row: ProjectSessionRow): number {
  const value = row.last_active ?? row.started_at ?? 0;
  return Number.isFinite(value) ? Number(value) : 0;
}

/**
 * Which project a session id belongs to, from the tree's `sessionIds`.
 *
 * The flat "Recents" list uses `scoped_session_ids` to avoid repeating rows that
 * the project view already owns; this answers the finer question ("open on the
 * project tab, then highlight this row").
 */
export function projectIdForSession(tree: ProjectsTree | null | undefined, sessionId: string): string | null {
  for (const project of tree?.projects ?? []) {
    if (project.sessionIds?.includes(sessionId)) return project.id;
  }
  return null;
}

// ── removing / renaming a project ────────────────────────────────────────────

/**
 * What "delete" can even mean for one node.
 *
 * Only an explicit project has a row in `projects.db`, so only it can be
 * deleted (`projects.delete`). An auto-discovered git repo's id is just its
 * path — the backend answers `5062 no such project` — so the desktop app hides
 * it client-side instead, and this plugin does the same. The Home bucket is
 * synthesised by the backend every read; there is nothing to remove.
 */
export type ProjectRemoval = "delete" | "hide" | "none";

export function projectRemoval(project: ProjectNode): ProjectRemoval {
  if (project.isNoProject) return "none";
  return project.isAuto ? "hide" : "delete";
}

/** Renaming writes a `projects.db` row, which only an explicit project has. */
export function canRenameProject(project: ProjectNode): boolean {
  return !project.isNoProject && !project.isAuto;
}

/**
 * Client-side hides, per profile.
 *
 * Mirrors the desktop sidebar's `hermes.desktop.dismissedAutoProjects`: a
 * hidden auto project is filtered out of the tree the user sees, and nothing is
 * written to the backend. Kept here (not in `localStorage` directly) so the
 * filter is testable and the key is per-profile — two profiles that drive
 * different repos must not hide each other's rows.
 */
export const HIDDEN_PROJECTS_STORAGE_PREFIX = "hermes-bubbles-hidden-projects:";

export interface HiddenProjectStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function hiddenProjectsKey(profile?: string | null): string {
  return `${HIDDEN_PROJECTS_STORAGE_PREFIX}${profile ?? ""}`;
}

/** The hidden ids for one profile; a malformed value reads as "none hidden". */
export function readHiddenProjects(storage: HiddenProjectStorage | null, profile?: string | null): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(hiddenProjectsKey(profile));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

/** Persist the hidden ids; an empty list clears the key rather than storing `[]`. */
export function writeHiddenProjects(
  storage: HiddenProjectStorage | null,
  profile: string | null | undefined,
  ids: readonly string[],
): void {
  if (!storage) return;
  try {
    const key = hiddenProjectsKey(profile);
    const unique = [...new Set(ids.filter((id) => id.length > 0))];
    if (unique.length) storage.setItem(key, JSON.stringify(unique));
    else storage.removeItem(key);
  } catch {
    // Storage unavailable (private mode / quota): the hide still applies to
    // this page's state, which is what the user is looking at.
  }
}

/**
 * Drop the hidden rows from a project list.
 *
 * Only auto nodes are affected: an explicit project's id can never collide with
 * a hidden entry, and the Home bucket must stay visible.
 */
export function visibleProjectRows(rows: readonly ProjectRow[], hidden: readonly string[]): ProjectRow[] {
  if (!hidden.length) return [...rows];
  const hiddenSet = new Set(hidden);
  return rows.filter((row) => !(row.project.isAuto === true && hiddenSet.has(row.project.id)));
}

/** How many hiding entries still match a row — the count behind "restore". */
export function hiddenProjectCount(rows: readonly ProjectRow[], hidden: readonly string[]): number {
  if (!hidden.length) return 0;
  const hiddenSet = new Set(hidden);
  return rows.filter((row) => row.project.isAuto === true && hiddenSet.has(row.project.id)).length;
}
