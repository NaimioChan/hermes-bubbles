import { describe, expect, it } from "vitest";

import {
  lastActiveOf,
  NO_PROJECT_ID,
  projectIdForSession,
  projectRows,
  projectWorkspacePath,
  sessionsOfProject,
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
