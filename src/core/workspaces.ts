/**
 * Workspace plumbing: which host directory a FRESH chat starts in.
 *
 * Mirrors the dashboard's own `/chat` picker (`web/src/lib/chat-workspaces.ts`)
 * so both surfaces offer the same list from the same payload
 * (`GET /api/chat/workspaces` → projects + discovered repos + default_cwd).
 *
 * The choice only affects a chat that has not been created yet: the backend
 * stamps `cwd` on the session row at `session.create` time, and a resumed
 * session keeps the directory it was born in. So this is "the workspace for the
 * next new chat", not "move this chat".
 *
 * Pure: no DOM, no storage API — the caller passes a `StorageLike`. AGENTS.md
 * 铁律 1 keeps `src/core/` testable without a browser.
 */

export interface WorkspaceFolder {
  path: string;
  label?: string | null;
  is_primary?: boolean;
}

export interface WorkspaceProject {
  id?: string;
  name: string;
  archived?: boolean;
  primary_path?: string | null;
  folders?: WorkspaceFolder[];
}

export interface WorkspaceRepo {
  root: string;
  label?: string;
  last_active?: number;
}

/** The shape `GET /api/chat/workspaces` answers with. Everything is optional:
 *  a host that cannot scan (headless install, no projects) still answers. */
export interface WorkspacesPayload {
  projects?: WorkspaceProject[];
  repos?: WorkspaceRepo[];
  default_cwd?: string;
  home?: string;
  scan_enabled?: boolean;
}

export interface WorkspaceOption {
  /** Absolute host path — what `session.create` takes as `cwd`. */
  value: string;
  /** Primary text: the project name, or the repo's directory name. */
  label: string;
  /** Secondary text: the `~`-abbreviated path. */
  hint: string;
}

/** Per-profile storage key, so two profiles driving different repos coexist. */
export const WORKSPACE_STORAGE_PREFIX = "hermes-bubbles-workspace:";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function workspaceStorageKey(profile?: string | null): string {
  return `${WORKSPACE_STORAGE_PREFIX}${profile ?? ""}`;
}

export function readStoredWorkspace(storage: StorageLike | null, profile?: string | null): string {
  if (!storage) return "";
  try {
    return storage.getItem(workspaceStorageKey(profile)) ?? "";
  } catch {
    return "";
  }
}

/**
 * Persist the pick. An empty value clears the key rather than storing `""`, so
 * "no workspace" and "never picked" stay the same state.
 */
export function writeStoredWorkspace(
  storage: StorageLike | null,
  profile: string | null | undefined,
  cwd: string,
): void {
  if (!storage) return;
  try {
    const key = workspaceStorageKey(profile);
    if (cwd) storage.setItem(key, cwd);
    else storage.removeItem(key);
  } catch {
    // Storage unavailable (private mode / quota): the pick still applies to
    // this session's controller, which is what the user is looking at.
  }
}

/** `~`-abbreviate a host path for compact display. Windows paths included. */
export function abbreviateHomePath(path: string, home: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const root = (home ?? "").replace(/[\\/]+$/, "");
  if (!root) return path;
  if (trimmed === root) return "~";
  const sep = trimmed.startsWith(`${root}/`) ? "/" : trimmed.startsWith(`${root}\\`) ? "\\" : null;
  return sep ? `~${sep}${trimmed.slice(root.length + 1)}` : path;
}

/** Last path segment, for a repo row whose payload has no label. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Flatten the payload into picker rows: explicit project folders first (a
 * multi-folder project contributes one row per folder, labelled with the folder
 * so two rows of the same project are tellable apart), then discovered repos not
 * already covered by a project folder, most recently active first. Deduped on
 * the path.
 */
export function workspaceOptions(data: WorkspacesPayload | null | undefined): WorkspaceOption[] {
  if (!data) return [];
  const home = data.home ?? "";
  const seen = new Set<string>();
  const out: WorkspaceOption[] = [];
  const push = (value: string, label: string) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({ value, label, hint: abbreviateHomePath(value, home) });
  };

  for (const project of data.projects ?? []) {
    if (project.archived) continue;
    const folders = project.folders?.length
      ? project.folders
      : project.primary_path
        ? [{ path: project.primary_path, label: null, is_primary: true }]
        : [];
    for (const folder of folders) {
      const suffix = folders.length > 1 ? ` · ${folder.label || baseName(folder.path)}` : "";
      push(folder.path, `${project.name}${suffix}`);
    }
  }

  const repos = [...(data.repos ?? [])].sort((a, b) => (b.last_active ?? 0) - (a.last_active ?? 0));
  for (const repo of repos) {
    push(repo.root, repo.label || baseName(repo.root));
  }
  return out;
}

/**
 * The chip's text for a cwd: the default label when nothing is picked, the
 * matching option's name when the path is still listed, else the abbreviated
 * path (a repo can drop out of discovery while still being a valid workspace).
 */
export function workspaceLabel(
  cwd: string,
  options: readonly WorkspaceOption[],
  home: string,
  defaultLabel: string,
): string {
  if (!cwd) return defaultLabel;
  const hit = options.find((option) => option.value === cwd);
  return hit ? hit.label : abbreviateHomePath(cwd, home);
}

/**
 * The `cwd` params for `session.create`.
 *
 * `cwd_explicit` is provenance, not a duplicate: the backend adopts a client
 * path it cannot `isdir`-probe only when the client says the user picked it
 * (`tui_gateway/session_workdir.py::_resolve_create_cwd`). Without it a
 * dashboard running against a remote/containerised backend silently drops the
 * workspace and the new chat lands in the launch directory.
 */
export function createCwdParams(cwd: string): { cwd?: string; cwd_explicit?: boolean } {
  const value = (cwd ?? "").trim();
  return value ? { cwd: value, cwd_explicit: true } : {};
}
