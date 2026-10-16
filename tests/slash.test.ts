import { describe, expect, it } from "vitest";

import {
  applyCompletion,
  entriesFromCatalog,
  entriesFromCompletion,
  filterCommands,
  findSlashToken,
  isReasoningLevel,
  parseCommandInput,
  parseDispatch,
  reasoningLabel,
  REASONING_LEVELS,
  type CommandEntry,
} from "../src/core/slash";

describe("findSlashToken", () => {
  it("finds a token at the start of the composer", () => {
    expect(findSlashToken("/ski", 4)).toEqual({ raw: "/ski", query: "ski", start: 0, end: 4 });
  });

  it("finds a bare slash (the show-everything case)", () => {
    expect(findSlashToken("/", 1)).toEqual({ raw: "/", query: "", start: 0, end: 1 });
  });

  it("finds a token after whitespace on the same line", () => {
    const text = "看看 /help";
    expect(findSlashToken(text, text.length)).toMatchObject({ query: "help", start: 3 });
  });

  it("ignores a slash inside a path", () => {
    expect(findSlashToken("src/foo", 7)).toBeNull();
  });

  it("does not reach back across a newline", () => {
    expect(findSlashToken("第一行\n/help", 10)).toMatchObject({ query: "help", start: 4 });
    // Caret on the second line before the slash: no token.
    expect(findSlashToken("第一行\n/help", 4)).toBeNull();
  });

  it("stops at whitespace", () => {
    // Caret sits after the space, so the token already ended.
    expect(findSlashToken("/help ", 6)).toBeNull();
  });

  it("rejects a token with characters a command name cannot contain", () => {
    expect(findSlashToken("/he llo", 7)).toBeNull();
  });

  it("allows the separators real command names use", () => {
    expect(findSlashToken("/skill:view", 11)).toMatchObject({ query: "skill:view" });
    expect(findSlashToken("/model.opts", 11)).toMatchObject({ query: "model.opts" });
  });

  it("clamps a caret past the end", () => {
    expect(findSlashToken("/he", 99)).toMatchObject({ query: "he", end: 3 });
  });
});

describe("applyCompletion", () => {
  it("replaces the token and appends a trailing space", () => {
    const token = findSlashToken("/ski", 4);
    expect(token).not.toBeNull();
    const result = applyCompletion("/ski", token!, "skill:view");
    expect(result.text).toBe("/skill:view ");
    expect(result.caret).toBe(12);
  });

  it("keeps text after the caret", () => {
    const text = "/he 后面的字";
    const token = findSlashToken(text, 3);
    const result = applyCompletion(text, token!, "help");
    expect(result.text).toBe("/help  后面的字");
  });
});

describe("filterCommands", () => {
  const entries: CommandEntry[] = [
    { name: "help", description: "显示帮助", kind: "command" },
    { name: "model", description: "切换模型", kind: "command" },
    { name: "skill:view", description: "查看技能", kind: "skill", usage: 3 },
    { name: "skill:manage", description: "编辑技能", kind: "skill", usage: 9 },
  ];

  it("returns everything for an empty query, commands before skills", () => {
    const result = filterCommands(entries, "");
    expect(result.map((e) => e.name)).toEqual(["help", "model", "skill:manage", "skill:view"]);
  });

  it("matches on name", () => {
    expect(filterCommands(entries, "mod").map((e) => e.name)).toEqual(["model"]);
  });

  it("matches on description too", () => {
    expect(filterCommands(entries, "切换").map((e) => e.name)).toEqual(["model"]);
  });

  it("ranks prefix matches above substring matches", () => {
    const list: CommandEntry[] = [
      { name: "unhelp", description: "", kind: "command" },
      { name: "help", description: "", kind: "command" },
    ];
    expect(filterCommands(list, "help").map((e) => e.name)).toEqual(["help", "unhelp"]);
  });

  it("ranks skills by usage", () => {
    const skills = entries.filter((e) => e.kind === "skill");
    expect(filterCommands(skills, "skill:").map((e) => e.name)).toEqual(["skill:manage", "skill:view"]);
  });

  it("is case-insensitive", () => {
    expect(filterCommands(entries, "HELP").map((e) => e.name)).toEqual(["help"]);
  });

  it("honours an explicit limit", () => {
    expect(filterCommands(entries, "", 2)).toHaveLength(2);
  });

  it("returns every match when the limit is large (the menu must not truncate)", () => {
    // A real install matches 100+ commands on a bare "/". The old 12-row cap made
    // most of them unreachable: filtering ran on the already-cut list.
    const many: CommandEntry[] = Array.from({ length: 150 }, (_, i) => ({
      name: `cmd${i}`,
      description: "",
      kind: "command" as const,
    }));
    expect(filterCommands(many, "", 200)).toHaveLength(150);
    expect(filterCommands(many, "", 12)).toHaveLength(12);
  });

  it("filters the whole set, not a pre-truncated slice", () => {
    const many: CommandEntry[] = Array.from({ length: 150 }, (_, i) => ({
      name: `cmd${i}`,
      description: "",
      kind: "command" as const,
    }));
    // cmd149 sorts last, so a 12-row pre-cut would lose it entirely.
    expect(filterCommands(many, "cmd149", 200).map((e) => e.name)).toEqual(["cmd149"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterCommands(entries, "zzzz")).toEqual([]);
  });
});

describe("entriesFromCompletion", () => {
  it("normalizes a complete.slash reply", () => {
    const entries = entriesFromCompletion([
      { text: "/help", display: "显示帮助", kind: "command" },
      { text: "skill:view", display: "查看技能", kind: "skill" },
    ]);
    expect(entries).toEqual([
      { name: "help", description: "显示帮助", kind: "command" },
      { name: "skill:view", description: "查看技能", kind: "skill" },
    ]);
  });

  it("falls back to meta when display is absent", () => {
    expect(entriesFromCompletion([{ text: "x", meta: "说明" }])[0]).toMatchObject({ description: "说明" });
  });

  it("skips empty items", () => {
    expect(entriesFromCompletion([{ text: "/" }, { text: "" }])).toEqual([]);
  });
});

describe("entriesFromCatalog", () => {
  it("flattens categories and appends skills", () => {
    const entries = entriesFromCatalog({
      categories: [{ name: "常用", pairs: [["help", "显示帮助"], ["model", "切换模型"]] }],
      skills: { "skill:view": { usage: 2, origin: "local" } },
    });
    expect(entries.map((e) => e.name)).toEqual(["help", "model", "skill:view"]);
    expect(entries[2]).toMatchObject({ kind: "skill", usage: 2 });
  });

  it("falls back to the flat pairs list when there are no categories", () => {
    const entries = entriesFromCatalog({ pairs: [["help", "显示帮助"]] });
    expect(entries.map((e) => e.name)).toEqual(["help"]);
  });

  it("dedupes a command that appears in both places", () => {
    const entries = entriesFromCatalog({
      categories: [{ name: "c", pairs: [["help", "a"]] }],
      pairs: [["help", "a"]],
      skills: {},
    });
    expect(entries).toHaveLength(1);
  });

  it("strips a leading slash from names", () => {
    expect(entriesFromCatalog({ pairs: [["/help", "x"]] })[0]?.name).toBe("help");
  });

  it("survives an empty catalog", () => {
    expect(entriesFromCatalog({})).toEqual([]);
  });
});

describe("parseCommandInput", () => {
  it("splits a command from its argument", () => {
    expect(parseCommandInput("/model gpt-4 --provider openai")).toEqual({
      name: "model",
      arg: "gpt-4 --provider openai",
    });
  });

  it("handles a command with no argument", () => {
    expect(parseCommandInput("/help")).toEqual({ name: "help", arg: "" });
  });

  it("returns null for plain text", () => {
    expect(parseCommandInput("你好")).toBeNull();
  });

  it("returns null for a bare slash", () => {
    expect(parseCommandInput("/")).toBeNull();
  });
});

describe("parseDispatch", () => {
  it("accepts each documented shape", () => {
    expect(parseDispatch({ type: "exec", output: "ok" })).toEqual({ type: "exec", output: "ok" });
    expect(parseDispatch({ type: "plugin", output: "ok" })).toEqual({ type: "plugin", output: "ok" });
    expect(parseDispatch({ type: "alias", target: "/model" })).toEqual({ type: "alias", target: "/model" });
    expect(parseDispatch({ type: "send", message: "hi", display: "hi" })).toMatchObject({ type: "send", message: "hi" });
    expect(parseDispatch({ type: "prefill", message: "draft" })).toMatchObject({ type: "prefill", message: "draft" });
    expect(parseDispatch({ type: "skill", name: "view" })).toMatchObject({ type: "skill", name: "view" });
  });

  it("rejects a shape that is missing its required field", () => {
    expect(parseDispatch({ type: "alias" })).toBeNull();
    expect(parseDispatch({ type: "send" })).toBeNull();
    expect(parseDispatch({ type: "skill" })).toBeNull();
  });

  it("rejects an unknown type rather than guessing", () => {
    expect(parseDispatch({ type: "wat" })).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(parseDispatch(null)).toBeNull();
    expect(parseDispatch("exec")).toBeNull();
    expect(parseDispatch([{ type: "exec" }])).toBeNull();
  });
});

describe("reasoning levels", () => {
  it("exposes the seven ranked levels", () => {
    expect(REASONING_LEVELS).toHaveLength(7);
    expect(REASONING_LEVELS[0]).toBe("minimal");
    expect(REASONING_LEVELS.at(-1)).toBe("ultra");
  });

  it("validates levels and rejects the off sentinel", () => {
    expect(isReasoningLevel("high")).toBe(true);
    expect(isReasoningLevel("none")).toBe(false);
    expect(isReasoningLevel("")).toBe(false);
  });

  it("labels known levels in Chinese and passes unknown ones through", () => {
    expect(reasoningLabel("medium")).toBe("中");
    expect(reasoningLabel("ultra")).toBe("极限");
    expect(reasoningLabel("mystery")).toBe("mystery");
  });
});
