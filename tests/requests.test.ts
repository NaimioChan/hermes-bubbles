import { describe, expect, it } from "vitest";

import {
  approvalLabel,
  approvalResult,
  clarifyAnswer,
  clarifyReady,
  clarifyResult,
  parseApproval,
  parseClarifyQuestions,
} from "../src/core/requests";

describe("requests: approval", () => {
  it("uses the server's own choice list, in its order", () => {
    // The bug this exists for: the card hardcoded all four choices, so a command
    // the backend only lets you allow once still offered "Always allow".
    const view = parseApproval({ request_id: "r1", choices: ["once", "deny"] });
    expect(view.choices).toEqual(["once", "deny"]);
  });

  it("preserves a non-standard order rather than sorting", () => {
    expect(parseApproval({ choices: ["deny", "once"] }).choices).toEqual(["deny", "once"]);
  });

  it("falls back to all four only when the server sends none", () => {
    expect(parseApproval({}).choices).toEqual(["once", "session", "always", "deny"]);
    expect(parseApproval({ choices: [] }).choices).toEqual(["once", "session", "always", "deny"]);
  });

  it("drops an unknown choice instead of rendering a dead button", () => {
    // A newer backend tier this client does not know must not become a button
    // that sends a value the backend rejects.
    const view = parseApproval({ choices: ["once", "maybe", 42, null, "deny"] });
    expect(view.choices).toEqual(["once", "deny"]);
  });

  it("reads the command, description and tool name", () => {
    const view = parseApproval({
      request_id: "req-9",
      command: "rm -rf /tmp/x",
      description: "recursive delete",
      tool_name: "terminal",
    });
    expect(view).toMatchObject({
      requestId: "req-9",
      command: "rm -rf /tmp/x",
      description: "recursive delete",
      toolName: "terminal",
    });
  });

  it("tolerates missing and wrongly-typed fields", () => {
    const view = parseApproval({ command: 123, description: null, tool_name: {} });
    expect(view.command).toBe("");
    expect(view.description).toBe("");
    expect(view.toolName).toBe("");
    expect(view.choices).toHaveLength(4);
  });

  it("builds the result the backend expects", () => {
    expect(approvalResult("once")).toEqual({ choice: "once" });
    expect(approvalResult("deny")).toEqual({ choice: "deny" });
  });

  it("labels every choice in both languages", () => {
    expect(approvalLabel("once", "en")).toBe("Allow once");
    expect(approvalLabel("always", "zh")).toBe("总是允许");
    expect(approvalLabel("deny", "en")).toBe("Deny");
  });
});

describe("requests: clarify", () => {
  const params = {
    questions: [
      { qid: "a", question: "选哪个？", choices: ["一", "二"] },
      { qid: "b", question: "哪些？", choices: ["x", "y", "z"], multi_select: true },
      { qid: "c", question: "补充说明？" },
    ],
  };

  it("parses the questions, choices and multi-select flag", () => {
    const qs = parseClarifyQuestions(params);
    expect(qs).toHaveLength(3);
    expect(qs[0]).toMatchObject({ qid: "a", choices: ["一", "二"], multiSelect: false });
    expect(qs[1]!.multiSelect).toBe(true);
    expect(qs[2]!.choices).toEqual([]);
  });

  it("skips a question with no qid (nothing could answer it)", () => {
    const qs = parseClarifyQuestions({ questions: [{ question: "无 id" }, { qid: "ok", question: "有" }] });
    expect(qs.map((q) => q.qid)).toEqual(["ok"]);
  });

  it("survives a missing or malformed questions list", () => {
    expect(parseClarifyQuestions({})).toEqual([]);
    expect(parseClarifyQuestions({ questions: "nope" })).toEqual([]);
    expect(parseClarifyQuestions({ questions: [null, 1, "x"] })).toEqual([]);
  });

  it("joins a multi-select answer into the single string the wire carries", () => {
    // ClarifyResult.answers is Record<string, string>, so a list must be joined.
    expect(clarifyAnswer(["x", "z"])).toBe("x, z");
    expect(clarifyAnswer(["solo"])).toBe("solo");
  });

  it("treats no selection as no answer", () => {
    expect(clarifyAnswer([])).toBeNull();
    expect(clarifyAnswer(["", "   "])).toBeNull();
  });

  it("omits unanswered questions and sends null when nothing was answered", () => {
    expect(clarifyResult({ a: ["一"], b: ["x", "y"] })).toEqual({ answers: { a: "一", b: "x, y" } });
    // A result with no `answers` is how the backend reads cancel-all.
    expect(clarifyResult({ a: [] })).toEqual({ answers: null });
  });

  it("requires every question before the batch can be submitted", () => {
    const qs = parseClarifyQuestions(params);
    expect(clarifyReady(qs, { a: ["一"], b: ["x"], c: ["说明"] })).toBe(true);
    expect(clarifyReady(qs, { a: ["一"], b: ["x"] })).toBe(false);
    expect(clarifyReady(qs, { a: [], b: ["x"], c: ["说明"] })).toBe(false);
  });

  it("is vacuously ready with no questions", () => {
    expect(clarifyReady([], {})).toBe(true);
  });
});
