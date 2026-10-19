import { describe, expect, it } from "vitest";

import {
  changedCount,
  gitBadgeText,
  gitBranchLabel,
  gitTargetDir,
  parseGitStatus,
} from "../src/core/gitinfo";

/** A clean checkout tracking an upstream, nothing to commit. */
const CLEAN = [
  "# branch.oid 4a2b1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b",
  "# branch.head main",
  "# branch.upstream origin/main",
  "# branch.ab +0 -0",
].join("\n");

describe("parseGitStatus", () => {
  it("returns null when the probe produced nothing (not a repo)", () => {
    expect(parseGitStatus("")).toBeNull();
    expect(parseGitStatus("fatal: not a git repository (or any of the parent directories): .git")).toBeNull();
  });

  it("reads a clean checkout", () => {
    const info = parseGitStatus(CLEAN, "C:/repo");
    expect(info).not.toBeNull();
    expect(info?.branch).toBe("main");
    expect(info?.detached).toBe(false);
    expect(info?.upstream).toBe("origin/main");
    expect(info?.ahead).toBe(0);
    expect(info?.behind).toBe(0);
    expect(info?.root).toBe("C:/repo");
    expect(changedCount(info!)).toBe(0);
  });

  it("counts staged, unstaged, untracked and unmerged entries separately", () => {
    const status = [
      CLEAN,
      "1 M. N... 100644 100644 100644 aaa bbb staged.txt",
      "1 .M N... 100644 100644 100644 aaa bbb unstaged.txt",
      "1 MM N... 100644 100644 100644 aaa bbb both.txt",
      "2 R. N... 100644 100644 100644 aaa bbb R100 renamed.txt\told.txt",
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt",
      "? new-file.txt",
      "? another.txt",
      "! ignored.log",
    ].join("\n");
    const info = parseGitStatus(status, "C:/repo")!;
    // `MM` is one path: it counts once as staged and once as unstaged.
    expect(info.staged).toBe(3);
    expect(info.unstaged).toBe(2);
    expect(info.untracked).toBe(2);
    expect(info.conflicts).toBe(1);
    expect(changedCount(info)).toBe(8);
  });

  it("reads tracking counts from the branch.ab header", () => {
    const info = parseGitStatus(
      ["# branch.oid abc1234", "# branch.head feature/x", "# branch.upstream origin/feature/x", "# branch.ab +3 -7"].join("\n"),
    )!;
    expect(info.ahead).toBe(3);
    expect(info.behind).toBe(7);
    expect(gitBadgeText(info)).toBe("feature/x ↑3 ↓7");
  });

  it("treats (detached) as detached and labels it with the short sha", () => {
    const info = parseGitStatus(["# branch.oid 9f8e7d6c5b4a", "# branch.head (detached)"].join("\n"))!;
    expect(info.detached).toBe(true);
    expect(info.branch).toBe("");
    expect(gitBranchLabel(info)).toBe("9f8e7d6");
  });

  it("survives a repo with no commits yet", () => {
    const info = parseGitStatus(["# branch.oid (initial)", "# branch.head master", "? first.txt"].join("\n"))!;
    expect(info.oid).toBe("");
    expect(info.branch).toBe("master");
    expect(info.untracked).toBe(1);
    expect(gitBranchLabel(info)).toBe("master");
  });

  it("marks capped counts instead of pretending they are exact", () => {
    const info = parseGitStatus([CLEAN, "? a", "? b"].join("\n"), "", true)!;
    expect(info.truncated).toBe(true);
    expect(gitBadgeText(info)).toBe("main 2+");
  });

  it("ignores Windows line endings", () => {
    const info = parseGitStatus([CLEAN, "? a"].join("\r\n"))!;
    expect(info.branch).toBe("main");
    expect(info.untracked).toBe(1);
  });
});

describe("gitTargetDir", () => {
  it("follows the open chat's own directory first", () => {
    expect(gitTargetDir("C:/work/b", "C:/work/a", "C:/Users/me")).toBe("C:/work/b");
  });

  it("with no session cwd it uses the pick for the next chat", () => {
    expect(gitTargetDir("", "C:/work/a", "C:/Users/me")).toBe("C:/work/a");
  });

  it("falls back to home when the host reports neither", () => {
    expect(gitTargetDir("  ", "", "C:/Users/me")).toBe("C:/Users/me");
  });

  it("trims whitespace so a stray space is not a distinct directory", () => {
    expect(gitTargetDir("  ", "  C:/work/a ", "")).toBe("C:/work/a");
  });
});

describe("gitBadgeText", () => {
  it("is the branch alone on a clean tree", () => {
    expect(gitBadgeText(parseGitStatus(CLEAN)!)).toBe("main");
  });

  it("appends the change count", () => {
    const info = parseGitStatus([CLEAN, "? a", "1 .M N... 100644 100644 100644 a b c.txt"].join("\n"))!;
    expect(gitBadgeText(info)).toBe("main 2");
  });
});
