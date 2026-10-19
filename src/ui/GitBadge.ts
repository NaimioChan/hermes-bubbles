/**
 * The git badge: branch + working-tree state, sitting to the right of the
 * workspace chip.
 *
 * It renders nothing at all when `info` is null — that is the whole
 * "no git, no display" rule: the workspace picker decides the directory, the
 * host answers whether it is a repo, and a plain folder keeps the chip row
 * exactly as it was before this feature existed.
 *
 * No hooks: the component is a pure function of its props, so it cannot shift
 * hook order (AGENTS.md 铁律 10) and needs no defensive early-return layout.
 */

import { changedCount, gitBranchLabel, type GitInfo } from "../core/gitinfo";
import { messagesFor, type Locale } from "../core/i18n";
import type { HermesPluginSdk } from "./sdk";

export interface GitBadgeProps {
  sdk: HermesPluginSdk;
  locale: Locale;
  /** `null` = not a repo (or the probe failed) — nothing renders. */
  info: GitInfo | null;
  loading: boolean;
  onRefresh: () => void;
}

export function GitBadge(props: GitBadgeProps) {
  const { React } = props.sdk;
  const info = props.info;
  if (!info) return null;

  const t = messagesFor(props.locale);
  const changed = changedCount(info);

  const counts: string[] = [];
  if (info.staged) counts.push(t.gitStaged(info.staged));
  if (info.unstaged) counts.push(t.gitUnstaged(info.unstaged));
  if (info.untracked) counts.push(t.gitUntracked(info.untracked));
  if (info.conflicts) counts.push(t.gitConflicts(info.conflicts));

  const lines = [
    info.root,
    info.detached ? `${t.gitDetached} (${gitBranchLabel(info)})` : gitBranchLabel(info),
    counts.length ? counts.join(" · ") : t.gitClean,
  ];
  if (info.ahead) lines.push(t.gitAhead(info.ahead));
  if (info.behind) lines.push(t.gitBehind(info.behind));
  if (info.truncated) lines.push(t.gitTruncated);
  lines.push(t.gitRefresh);
  const title = lines.filter(Boolean).join("\n");

  return React.createElement(
    "button",
    {
      type: "button",
      "data-hb": "git-badge",
      title,
      "aria-label": title,
      className: "hb-git-badge",
      style: { color: "var(--color-muted-foreground)" },
      onClick: props.onRefresh,
    },
    React.createElement("span", { className: "hb-git-mark" }, "⎇"),
    React.createElement("span", { className: "hb-git-branch" }, gitBranchLabel(info)),
    changed > 0
      ? React.createElement(
          "span",
          {
            className: "hb-git-changed",
            // Dirty is the one thing worth colouring: a warning tone the host
            // actually defines (an undefined var here drops the declaration).
            style: { color: "var(--color-warning)" },
          },
          info.truncated ? `${changed}+` : String(changed),
        )
      : null,
    info.ahead > 0 ? React.createElement("span", { className: "hb-git-track" }, `↑${info.ahead}`) : null,
    info.behind > 0 ? React.createElement("span", { className: "hb-git-track" }, `↓${info.behind}`) : null,
  );
}
