import { describe, expect, it } from "vitest";

import {
  abbreviateHomePath,
  baseName,
  createCwdParams,
  readStoredWorkspace,
  workspaceLabel,
  workspaceOptions,
  workspaceStorageKey,
  writeStoredWorkspace,
  type StorageLike,
  type WorkspacesPayload,
} from "../src/core/workspaces";

function fakeStorage(seed: Record<string, string> = {}): StorageLike & { dump: () => Record<string, string> } {
  const data = { ...seed };
  return {
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
    dump: () => ({ ...data }),
  };
}

const PAYLOAD: WorkspacesPayload = {
  home: "/home/me",
  default_cwd: "/home/me/code/hermes-agent",
  projects: [
    {
      id: "p1",
      name: "Hermes",
      folders: [{ path: "/home/me/code/hermes-agent", label: null, is_primary: true }],
    },
    {
      id: "p2",
      name: "Music",
      folders: [
        { path: "/home/me/code/daw", label: "daw" },
        { path: "/home/me/code/plugins", label: "plugins" },
      ],
    },
    { id: "p3", name: "Old", archived: true, folders: [{ path: "/home/me/old" }] },
    { id: "p4", name: "Solo", primary_path: "/home/me/code/solo" },
  ],
  repos: [
    { root: "/home/me/code/daw", label: "daw", last_active: 10 },
    { root: "/home/me/code/lighthouse", label: "LightHouse", last_active: 30 },
    { root: "/home/me/code/zzz", last_active: 20 },
  ],
};

describe("abbreviateHomePath", () => {
  it("collapses the home prefix to ~", () => {
    expect(abbreviateHomePath("/home/me/code/daw", "/home/me")).toBe("~/code/daw");
  });

  it("collapses home itself", () => {
    expect(abbreviateHomePath("/home/me", "/home/me/")).toBe("~");
  });

  it("handles Windows separators and a trailing slash on the path", () => {
    expect(abbreviateHomePath("C:\\Users\\Naimio\\projects\\dawview\\", "C:\\Users\\Naimio")).toBe(
      "~\\projects\\dawview",
    );
  });

  it("leaves a path outside home alone", () => {
    expect(abbreviateHomePath("D:/work/thing", "/home/me")).toBe("D:/work/thing");
  });

  it("is identity when home is unknown", () => {
    expect(abbreviateHomePath("/srv/app", "")).toBe("/srv/app");
  });
});

describe("baseName", () => {
  it("takes the last segment on either separator style", () => {
    expect(baseName("/home/me/code/lighthouse")).toBe("lighthouse");
    expect(baseName("C:\\Users\\Naimio\\projects\\dawview")).toBe("dawview");
    expect(baseName("/home/me/code/daw/")).toBe("daw");
  });
});

describe("workspaceOptions", () => {
  const options = workspaceOptions(PAYLOAD);

  it("lists project folders first, in payload order", () => {
    expect(options.slice(0, 3).map((option) => option.value)).toEqual([
      "/home/me/code/hermes-agent",
      "/home/me/code/daw",
      "/home/me/code/plugins",
    ]);
  });

  it("names a multi-folder project's rows after the folder", () => {
    expect(options[1]?.label).toBe("Music · daw");
    expect(options[2]?.label).toBe("Music · plugins");
  });

  it("labels a single-folder project with just the project name", () => {
    expect(options[0]?.label).toBe("Hermes");
  });

  it("falls back to primary_path when a project has no folders", () => {
    expect(options.find((option) => option.value === "/home/me/code/solo")?.label).toBe("Solo");
  });

  it("skips archived projects", () => {
    expect(options.some((option) => option.value === "/home/me/old")).toBe(false);
  });

  it("appends discovered repos not already covered, newest first", () => {
    const tail = options.slice(4).map((option) => option.value);
    expect(tail).toEqual(["/home/me/code/lighthouse", "/home/me/code/zzz"]);
  });

  it("uses the repo label when present, else the directory name", () => {
    expect(options.find((option) => option.value === "/home/me/code/lighthouse")?.label).toBe("LightHouse");
    expect(options.find((option) => option.value === "/home/me/code/zzz")?.label).toBe("zzz");
  });

  it("dedupes on the path", () => {
    const values = options.map((option) => option.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it("carries the ~-abbreviated path as the hint", () => {
    expect(options[0]?.hint).toBe("~/code/hermes-agent");
  });

  it("tolerates an empty payload", () => {
    expect(workspaceOptions(null)).toEqual([]);
    expect(workspaceOptions({})).toEqual([]);
  });
});

describe("workspaceLabel", () => {
  const options = workspaceOptions(PAYLOAD);

  it("shows the default label when nothing is picked", () => {
    expect(workspaceLabel("", options, "/home/me", "Default directory")).toBe("Default directory");
  });

  it("shows the option's name for a listed path", () => {
    expect(workspaceLabel("/home/me/code/lighthouse", options, "/home/me", "Default")).toBe("LightHouse");
  });

  it("falls back to the abbreviated path for a path that left the list", () => {
    expect(workspaceLabel("/home/me/code/gone", options, "/home/me", "Default")).toBe("~/code/gone");
  });
});

describe("createCwdParams", () => {
  it("sends nothing when no workspace is picked", () => {
    expect(createCwdParams("")).toEqual({});
    expect(createCwdParams("   ")).toEqual({});
  });

  it("sends cwd with explicit provenance", () => {
    expect(createCwdParams("/home/me/code/daw")).toEqual({
      cwd: "/home/me/code/daw",
      cwd_explicit: true,
    });
  });

  it("trims a pasted path", () => {
    expect(createCwdParams("  /home/me/code/daw  ")).toEqual({
      cwd: "/home/me/code/daw",
      cwd_explicit: true,
    });
  });
});

describe("workspace storage", () => {
  it("keys per profile", () => {
    expect(workspaceStorageKey()).toBe("hermes-bubbles-workspace:");
    expect(workspaceStorageKey("work")).toBe("hermes-bubbles-workspace:work");
  });

  it("round-trips a pick", () => {
    const storage = fakeStorage();
    writeStoredWorkspace(storage, "work", "/home/me/code/daw");
    expect(readStoredWorkspace(storage, "work")).toBe("/home/me/code/daw");
    expect(readStoredWorkspace(storage, "")).toBe("");
  });

  it("clears the key instead of storing an empty string", () => {
    const storage = fakeStorage();
    writeStoredWorkspace(storage, "", "/home/me/code/daw");
    writeStoredWorkspace(storage, "", "");
    expect(storage.dump()).toEqual({});
  });

  it("is silent when storage is unavailable", () => {
    expect(readStoredWorkspace(null, "")).toBe("");
    expect(() => writeStoredWorkspace(null, "", "/tmp")).not.toThrow();
  });
});
