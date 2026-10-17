import { describe, expect, it } from "vitest";

import { messagesFor } from "../src/core/i18n";
import {
  completionNotice,
  flatten,
  notifySwitch,
  requestNotice,
  shouldNotify,
  storedEnabled,
  testNotice,
  type NotifyGate,
} from "../src/core/notify";

const t = messagesFor("zh");
const gate = (patch: Partial<NotifyGate> = {}): NotifyGate => ({
  enabled: true,
  permission: "granted",
  background: true,
  ...patch,
});

describe("notify gate", () => {
  it("fires only when enabled, permitted and the window is in the background", () => {
    expect(shouldNotify(gate())).toBe(true);
  });

  it("stays quiet while the user is looking at the page", () => {
    expect(shouldNotify(gate({ background: false }))).toBe(false);
  });

  it("stays quiet when the switch is off", () => {
    expect(shouldNotify(gate({ enabled: false }))).toBe(false);
  });

  it("stays quiet without permission — default and denied both mean no", () => {
    expect(shouldNotify(gate({ permission: "default" }))).toBe(false);
    expect(shouldNotify(gate({ permission: "denied" }))).toBe(false);
  });

  it("treats anything but an explicit off as on", () => {
    expect(storedEnabled(null)).toBe(true);
    expect(storedEnabled("on")).toBe(true);
    expect(storedEnabled("off")).toBe(false);
  });
});

describe("notify switch", () => {
  it("only reads on when the browser has actually granted permission", () => {
    // The regression this guards: the stored preference defaults to on, so the
    // switch used to read "on" in a browser that had never been asked and could
    // never fire.
    expect(notifySwitch(true, "granted")).toBe("on");
    expect(notifySwitch(true, "default")).toBe("needs-permission");
    expect(notifySwitch(true, "denied")).toBe("blocked");
  });

  it("shows off when the user turned it off, whatever the permission says", () => {
    expect(notifySwitch(false, "granted")).toBe("off");
    expect(notifySwitch(false, "default")).toBe("off");
    expect(notifySwitch(false, "denied")).toBe("off");
  });
});

describe("flatten", () => {
  it("strips markdown down to one line", () => {
    const body = flatten("## 结论\n\n**已修复** `reduce.ts` 里的问题\n\n```ts\ncode()\n```");
    expect(body).toBe("结论 已修复 reduce.ts 里的问题");
  });

  it("keeps links' text and drops the URL", () => {
    expect(flatten("见 [文档](https://example.com/x) 第 3 节")).toBe("见 文档 第 3 节");
  });

  it("truncates with an ellipsis", () => {
    const body = flatten("一".repeat(200), 20);
    expect(body).toHaveLength(20);
    expect(body.endsWith("…")).toBe(true);
  });
});

describe("request notices", () => {
  it("leads with the command being asked about", () => {
    const spec = requestNotice(
      "approval",
      { command: "rm -rf build", tool_name: "shell" },
      t,
      "hb-request-1",
    );
    expect(spec.kind).toBe("approval");
    expect(spec.title).toBe(t.notifyApprovalTitle);
    expect(spec.body).toBe("rm -rf build");
    expect(spec.tag).toBe("hb-request-1");
  });

  it("prefers the description over the raw command", () => {
    const spec = requestNotice("approval", { command: "ls", description: "列出工作目录" }, t, "tag");
    expect(spec.body).toBe("列出工作目录");
  });

  it("uses the first question and counts the rest", () => {
    const spec = requestNotice(
      "clarify",
      { questions: [{ question: "要覆盖吗？" }, { question: "第二个问题" }] },
      t,
      "tag",
    );
    expect(spec.kind).toBe("clarify");
    expect(spec.body).toBe("要覆盖吗？ (+1)");
  });

  it("falls back to a generic body when the request carries no text", () => {
    const spec = requestNotice("clarify", {}, t, "tag");
    expect(spec.body).toBe(t.clarifyTitle);
  });

  it("stays on screen, because the agent is blocked until it is answered", () => {
    expect(requestNotice("approval", {}, t, "tag").sticky).toBe(true);
    expect(requestNotice("clarify", {}, t, "tag").sticky).toBe(true);
  });
});

describe("completion notices", () => {
  it("quotes the reply's first words", () => {
    const spec = completionNotice({ title: "重构 reduce", text: "改完了，397 项测试通过。" }, t, "tag");
    expect(spec.kind).toBe("done");
    expect(spec.title).toBe(`${t.notifyDoneTitle} · 重构 reduce`);
    expect(spec.body).toBe("改完了，397 项测试通过。");
  });

  it("reports a failure as a failure, not as a finished turn", () => {
    const spec = completionNotice({ title: "x", text: "部分输出", error: "上游 429" }, t, "tag");
    expect(spec.kind).toBe("failed");
    expect(spec.title).toBe(t.notifyFailedTitle);
    expect(spec.body).toBe("上游 429");
  });

  it("never leaves the body empty", () => {
    const spec = completionNotice({ title: "", text: "", error: "" }, t, "tag");
    expect(spec.body).toBe(t.notifyDoneTitle);
  });

  it("lets a finished turn fade out on its own", () => {
    expect(completionNotice({ text: "x" }, t, "tag").sticky).toBe(false);
  });
});

describe("test notice", () => {
  it("proves the path with its own tag, not the turn tag", () => {
    const spec = testNotice(t);
    expect(spec.tag).toBe("hb-test");
    expect(spec.title).toBe(t.notifyTestTitle);
    expect(spec.body).toBe(t.notifyTestBody);
  });
});
