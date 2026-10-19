/**
 * Git facts about the workspace directory, shown beside the workspace chip.
 *
 * The git call itself runs on the host (`plugin_api.py::/git`, where the repo
 * actually lives — the browser cannot spawn git). What comes back is git's own
 * `status --porcelain=v2 --branch` text; parsing it here keeps the fiddly part
 * pure and unit-tested (AGENTS.md 铁律 1), and keeps the backend dumb.
 *
 * Format reference: `git-status(1)`, "Porcelain Format Version 2". Header lines
 * are `# branch.<field> <value>`; entries start with `1` (changed), `2`
 * (renamed/copied), `u` (unmerged), `?` (untracked) or `!` (ignored).
 */

/** What `/git` answers. Everything optional: a probe may fail on any host. */
export interface GitStatusPayload {
  ok?: boolean;
  is_repo?: boolean;
  /** Directory the probe ran in, absolute. */
  path?: string;
  /** Repo top level (`--show-toplevel`), forward slashes. */
  root?: string;
  /** Raw `status --porcelain=v2 --branch` stdout. */
  status?: string;
  /** True when the backend capped the entry list. */
  truncated?: boolean;
  error?: string;
}

export interface GitInfo {
  /** Repo top level; "" when the host did not report one. */
  root: string;
  /** HEAD commit sha; "" before the first commit. */
  oid: string;
  /** Current branch; "" when detached. */
  branch: string;
  detached: boolean;
  upstream: string;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  /** The host capped the list, so the counts below are lower bounds. */
  truncated: boolean;
}

/**
 * Parse `git status --porcelain=v2 --branch`.
 *
 * `null` means "this is not a repository" (or the probe produced nothing
 * usable) — the caller renders no badge at all rather than an empty one.
 */
export function parseGitStatus(status: string, root = "", truncated = false): GitInfo | null {
  const info: GitInfo = {
    root: root ?? "",
    oid: "",
    branch: "",
    detached: false,
    upstream: "",
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicts: 0,
    truncated: truncated === true,
  };

  // A repository always emits at least `# branch.oid` / `# branch.head`, even
  // with no commits and no changes — so their absence is how "not a repo" (or a
  // failed probe returning stderr-ish text) is recognised.
  let sawHeader = false;

  for (const line of (status ?? "").split(/\r?\n/)) {
    if (!line) continue;

    if (line.startsWith("# ")) {
      sawHeader = true;
      const rest = line.slice(2);
      const space = rest.indexOf(" ");
      const key = space === -1 ? rest : rest.slice(0, space);
      const value = space === -1 ? "" : rest.slice(space + 1);
      if (key === "branch.oid") info.oid = value === "(initial)" ? "" : value;
      else if (key === "branch.head") {
        if (value === "(detached)") info.detached = true;
        else info.branch = value;
      } else if (key === "branch.upstream") info.upstream = value;
      else if (key === "branch.ab") {
        const match = /^\+(\d+)\s+-(\d+)$/.exec(value.trim());
        if (match) {
          info.ahead = Number(match[1]);
          info.behind = Number(match[2]);
        }
      }
      continue;
    }

    const kind = line[0];
    if (kind === "?") {
      info.untracked += 1;
      continue;
    }
    if (kind === "1" || kind === "2") {
      // `<kind> XY ...`: X = index status, Y = worktree status, "." = unchanged.
      const x = line[2] ?? ".";
      const y = line[3] ?? ".";
      if (x !== ".") info.staged += 1;
      if (y !== ".") info.unstaged += 1;
      continue;
    }
    if (kind === "u") {
      info.conflicts += 1;
      continue;
    }
    // `!` = ignored, and anything else is a header/format we do not model.
  }

  return sawHeader ? info : null;
}

/** Total paths git reports as changed (staged + unstaged + untracked + unmerged). */
export function changedCount(info: GitInfo): number {
  return info.staged + info.unstaged + info.untracked + info.conflicts;
}

/**
 * The compact badge text: branch (or the short sha when detached) plus change
 * and tracking counts. Glyphs only, no prose — the tooltip carries the words.
 */
export function gitBadgeText(info: GitInfo): string {
  const parts: string[] = [gitBranchLabel(info)];
  const changed = changedCount(info);
  if (changed > 0) parts.push(info.truncated ? `${changed}+` : String(changed));
  if (info.ahead > 0) parts.push(`↑${info.ahead}`);
  if (info.behind > 0) parts.push(`↓${info.behind}`);
  return parts.join(" ");
}

/** Branch name, or the abbreviated HEAD sha in detached state. */
export function gitBranchLabel(info: GitInfo): string {
  if (!info.detached) return info.branch || "HEAD";
  return info.oid ? info.oid.slice(0, 7) : "HEAD";
}

/**
 * Which directory the git badge describes.
 *
 * It follows the chip, and the chip is live: the open chat's own directory
 * comes first, then the pick for the next new chat, and only then home (a host
 * that reports no cwd at all).
 */
export function gitTargetDir(sessionCwd: string, pick: string, home: string): string {
  const open = (sessionCwd ?? "").trim();
  if (open) return open;
  const preference = (pick ?? "").trim();
  if (preference) return preference;
  return (home ?? "").trim();
}
