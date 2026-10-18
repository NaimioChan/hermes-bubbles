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
