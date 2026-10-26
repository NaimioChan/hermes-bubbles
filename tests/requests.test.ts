import { describe, expect, it } from "vitest";

import {
  approvalLabel,
  approvalResult,
  clarifyAnswer,
  clarifyReady,
  clarifyResult,
  parseApproval,
  parseClarifyQuestions,
  stageChoice,
  stageFreeText,
  stagedAnswerParts,
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

describe("requests: staging a clarify answer", () => {
  const single = { qid: "a", question: "选哪个？", choices: ["一", "二"], multiSelect: false };
  const multi = { qid: "b", question: "哪些？", choices: ["x", "y"], multiSelect: true };
  const open = { qid: "c", question: "补充？", choices: [], multiSelect: false };

  it("splits a staged answer into offered picks and typed text", () => {
    // The card always ends the list with a free-text row, so one value carries
    // both kinds; anything the server did not offer can only have been typed.
    expect(stagedAnswerParts(single, ["一"])).toEqual({ picked: ["一"], text: "" });
    expect(stagedAnswerParts(single, ["我自己写的"])).toEqual({ picked: [], text: "我自己写的" });
    expect(stagedAnswerParts(multi, ["x", "y", "别的"])).toEqual({ picked: ["x", "y"], text: "别的" });
    expect(stagedAnswerParts(open, ["随便"])).toEqual({ picked: [], text: "随便" });
    expect(stagedAnswerParts(single, [])).toEqual({ picked: [], text: "" });
  });

  it("keeps single-select mutually exclusive between a pick and typed text", () => {
    expect(stageChoice(single, [], "一")).toEqual(["一"]);
    // Picking replaces the other choice…
    expect(stageChoice(single, ["一"], "二")).toEqual(["二"]);
    // …clears typed text (the wire carries one string per question)…
    expect(stageChoice(single, ["我写的"], "一")).toEqual(["一"]);
    // …and clicking the picked choice again un-picks it.
    expect(stageChoice(single, ["一"], "一")).toEqual([]);
  });

  it("lets multi-select keep picks and typed text together", () => {
    expect(stageChoice(multi, [], "x")).toEqual(["x"]);
    expect(stageChoice(multi, ["x"], "y")).toEqual(["x", "y"]);
    // Typed text survives a toggle: it is an additional answer, not a pick.
    expect(stageChoice(multi, ["x", "我写的"], "y")).toEqual(["x", "y", "我写的"]);
    expect(stageChoice(multi, ["x", "我写的"], "x")).toEqual(["我写的"]);
  });

  it("stages typed text, replacing a pick only where the wire forces it", () => {
    expect(stageFreeText(single, [], "自由回答")).toEqual(["自由回答"]);
    expect(stageFreeText(single, ["一"], "自由回答")).toEqual(["自由回答"]);
    expect(stageFreeText(multi, ["x"], "自由回答")).toEqual(["x", "自由回答"]);
    // Editing the text after clearing it drops just the text, keeping picks.
    expect(stageFreeText(multi, ["x", "自由回答"], "")).toEqual(["x"]);
    expect(stageFreeText(single, ["自由回答"], "   ")).toEqual([]);
    expect(stageFreeText(open, [], "开放式")).toEqual(["开放式"]);
  });

  it("turns a staged free-text answer into the string the backend receives", () => {
    // End to end through the same helpers the card uses: a custom answer to a
    // choice question is what the model actually reads.
    const values = stageFreeText(single, stageChoice(single, [], "一"), "还是换个说法");
    expect(clarifyResult({ a: values })).toEqual({ answers: { a: "还是换个说法" } });
    const both = stageFreeText(multi, stageChoice(multi, [], "x"), "再加一条");
    expect(clarifyResult({ b: both })).toEqual({ answers: { b: "x, 再加一条" } });
    expect(clarifyReady([single, multi], { a: values, b: both })).toBe(true);
  });
});
