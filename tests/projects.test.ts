import { describe, expect, it } from "vitest";

import {
  canRenameProject,
  HIDDEN_PROJECTS_STORAGE_PREFIX,
  hiddenProjectCount,
  hiddenProjectsKey,
  lastActiveOf,
  NO_PROJECT_ID,
  projectIdForSession,
  projectRemoval,
  projectRows,
  projectWorkspacePath,
  readHiddenProjects,
  sessionsOfProject,
  visibleProjectRows,
  writeHiddenProjects,
  type ProjectNode,
  type ProjectsTree,
} from "../src/core/projects";

function project(over: Partial<ProjectNode>): ProjectNode {
  return { id: "p_1", label: "Hermes", ...over };
}

describe("projectRows", () => {
  it("orders by last activity, newest first", () => {
    const tree: ProjectsTree = {
      projects: [
        project({ id: "a", label: "A", lastActive: 10 }),
        project({ id: "b", label: "B", lastActive: 30 }),
        project({ id: "c", label: "C", lastActive: 20 }),
      ],
    };
    expect(projectRows(tree).map((row) => row.project.id)).toEqual(["b", "c", "a"]);
  });

  it("sinks the Home bucket to the bottom even when it is the most recent", () => {
    const tree: ProjectsTree = {
      projects: [
        project({ id: NO_PROJECT_ID, label: "Home", isNoProject: true, lastActive: 999 }),
        project({ id: "a", label: "A", lastActive: 1 }),
      ],
    };
    expect(projectRows(tree).map((row) => row.project.id)).toEqual(["a", NO_PROJECT_ID]);
  });

  it("carries the preview the tree already sent", () => {
    const tree: ProjectsTree = {
      projects: [
        project({
          previewSessions: [
            { id: "s1", title: "one" },
            { id: "s2", title: "two" },
          ],
        }),
      ],
    };
    expect(projectRows(tree)[0]?.preview.map((row) => row.id)).toEqual(["s1", "s2"]);
  });

  it("tolerates a missing tree", () => {
    expect(projectRows(null)).toEqual([]);
    expect(projectRows({})).toEqual([]);
  });
});

describe("projectWorkspacePath", () => {
  it("prefers the project's own path", () => {
    expect(projectWorkspacePath(project({ path: "/code/x", repos: [{ path: "/code/y" }] }))).toBe("/code/x");
  });

  it("falls back to the first repo path", () => {
    expect(
      projectWorkspacePath(project({ path: null, repos: [{ path: "" }, { path: "/code/y" }] })),
    ).toBe("/code/y");
  });

  it("is empty for the Home bucket and for a pathless project", () => {
    expect(projectWorkspacePath(project({ isNoProject: true, path: "/code/x" }))).toBe("");
    expect(projectWorkspacePath(project({}))).toBe("");
  });
});

describe("sessionsOfProject", () => {
  const hydrated = project({
    repos: [
      {
        id: "/code/x",
        groups: [
          { id: "lane-main", sessions: [{ id: "s1", title: "a", last_active: 10 }] },
          {
            id: "lane-branch",
            sessions: [
              { id: "s1", title: "a", last_active: 10, message_count: 4 },
              { id: "s2", title: "b", last_active: 30 },
            ],
          },
        ],
      },
    ],
    previewSessions: [{ id: "s2", title: "b", last_active: 30 }],
  });

  it("flattens every lane and dedupes by session id", () => {
    const rows = sessionsOfProject(hydrated);
    expect(rows.map((row) => row.id)).toEqual(["s2", "s1"]);
  });

  it("keeps the copy that carries more fields when the same session repeats", () => {
    const rows = sessionsOfProject(hydrated);
    expect(rows.find((row) => row.id === "s1")?.message_count).toBe(4);
  });

  it("is empty for a missing project", () => {
    expect(sessionsOfProject(null)).toEqual([]);
  });
});

describe("lastActiveOf", () => {
  it("prefers last_active, falls back to started_at", () => {
    expect(lastActiveOf({ id: "s", last_active: 5, started_at: 9 })).toBe(5);
    expect(lastActiveOf({ id: "s", started_at: 9 })).toBe(9);
    expect(lastActiveOf({ id: "s" })).toBe(0);
  });
});

describe("projectIdForSession", () => {
  const tree: ProjectsTree = {
    projects: [
      project({ id: "a", sessionIds: ["s1"] }),
      project({ id: "b", sessionIds: ["s2"] }),
    ],
  };

  it("finds the owning project", () => {
    expect(projectIdForSession(tree, "s2")).toBe("b");
  });

  it("returns null for a session no project claims", () => {
    expect(projectIdForSession(tree, "s9")).toBeNull();
    expect(projectIdForSession(null, "s1")).toBeNull();
  });
});

describe("projectRemoval / canRenameProject", () => {
  it("deletes an explicit project, hides an auto one, and leaves Home alone", () => {
    // The backend has a `projects.db` row only for explicit projects, so that is
    // the only tier `projects.delete` can act on. An auto node's id is a repo
    // path; a `projects.delete` on it answers 5062, which is why the desktop app
    // hides it client-side instead.
    expect(projectRemoval(project({ isAuto: false }))).toBe("delete");
    expect(projectRemoval(project({ isAuto: true }))).toBe("hide");
    expect(projectRemoval(project({ isNoProject: true }))).toBe("none");
  });

  it("offers rename only where there is a row to write", () => {
    expect(canRenameProject(project({ isAuto: false }))).toBe(true);
    expect(canRenameProject(project({ isAuto: true }))).toBe(false);
    expect(canRenameProject(project({ isNoProject: true }))).toBe(false);
  });
});

describe("hidden projects", () => {
  /** A minimal in-memory Storage, so the read/write pair is testable headless. */
  function memoryStorage(): {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    readonly dump: Record<string, string>;
  } {
    const dump: Record<string, string> = {};
    return {
      dump,
      getItem: (key) => dump[key] ?? null,
      setItem: (key, value) => {
        dump[key] = value;
      },
      removeItem: (key) => {
        delete dump[key];
      },
    };
  }

  const rows = projectRows({
    projects: [
      project({ id: "p_explicit", label: "Explicit" }),
      project({ id: "C:/repo/a", label: "A", isAuto: true }),
      project({ id: "C:/repo/b", label: "B", isAuto: true }),
      project({ id: NO_PROJECT_ID, label: "Home", isNoProject: true }),
    ],
  });

  it("keys the store per profile", () => {
    expect(hiddenProjectsKey("")).toBe(`${HIDDEN_PROJECTS_STORAGE_PREFIX}`);
    expect(hiddenProjectsKey("work")).toBe(`${HIDDEN_PROJECTS_STORAGE_PREFIX}work`);
  });

  it("round-trips the hidden ids and dedupes them", () => {
    const storage = memoryStorage();
    writeHiddenProjects(storage, "work", ["C:/repo/a", "C:/repo/a", "C:/repo/b"]);
    expect(readHiddenProjects(storage, "work")).toEqual(["C:/repo/a", "C:/repo/b"]);
    // Another profile's list is untouched.
    expect(readHiddenProjects(storage, "")).toEqual([]);
  });

  it("clears the key rather than storing an empty list", () => {
    const storage = memoryStorage();
    writeHiddenProjects(storage, "", ["C:/repo/a"]);
    writeHiddenProjects(storage, "", []);
    expect(storage.getItem(hiddenProjectsKey(""))).toBeNull();
  });

  it("reads a malformed or missing value as nothing hidden", () => {
    const storage = memoryStorage();
    expect(readHiddenProjects(storage, "")).toEqual([]);
    expect(readHiddenProjects(null, "")).toEqual([]);
    storage.setItem(hiddenProjectsKey(""), "{not json");
    expect(readHiddenProjects(storage, "")).toEqual([]);
    storage.setItem(hiddenProjectsKey(""), '{"a":1}');
    expect(readHiddenProjects(storage, "")).toEqual([]);
    storage.setItem(hiddenProjectsKey(""), '["ok", 3, null]');
    expect(readHiddenProjects(storage, "")).toEqual(["ok"]);
  });

  // Row order is `projectRows`' business (last activity, then label); these
  // assertions read the surviving ids as a set so a reordering there does not
  // masquerade as a filter bug.
  const ids = (list: ReturnType<typeof visibleProjectRows>) =>
    list.map((row) => row.project.id).sort();

  it("drops only the hidden auto rows", () => {
    expect(ids(visibleProjectRows(rows, ["C:/repo/a"]))).toEqual(
      ["C:/repo/b", NO_PROJECT_ID, "p_explicit"].sort(),
    );
    expect(visibleProjectRows(rows, [])).toHaveLength(4);
  });

  it("never hides an explicit project or the Home bucket", () => {
    // A stale entry must not be able to erase a real project: the ids can only
    // come from auto nodes, but a hand-edited localStorage value should not be
    // able to break the list either.
    const visible = visibleProjectRows(rows, ["p_explicit", NO_PROJECT_ID]);
    expect(ids(visible)).toEqual(["C:/repo/a", "C:/repo/b", NO_PROJECT_ID, "p_explicit"].sort());
  });

  it("counts only entries that still match a row", () => {
    expect(hiddenProjectCount(rows, [])).toBe(0);
    // `C:/repo/gone` was hidden before that checkout disappeared: nothing to
    // restore, so the count must not advertise it.
    expect(hiddenProjectCount(rows, ["C:/repo/a", "C:/repo/gone"])).toBe(1);
    expect(hiddenProjectCount(rows, ["p_explicit"])).toBe(0);
  });
});
