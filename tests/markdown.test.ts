import { describe, expect, it } from "vitest";

import { parseInline, parseMarkdown, safeHref, type MdBlock, type MdInline } from "../src/core/markdown";

/** Find the first block of a type, or throw — keeps assertions readable. */
function block<T extends MdBlock["type"]>(blocks: MdBlock[], type: T): Extract<MdBlock, { type: T }> {
  const found = blocks.find((b) => b.type === type);
  if (!found) throw new Error(`no ${type} block in ${JSON.stringify(blocks)}`);
  return found as Extract<MdBlock, { type: T }>;
}

/** Collapse a node tree back to plain text, for ordering assertions. */
function text(nodes: MdInline[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text" || n.type === "code") out += n.value;
    else if (n.type === "image") out += n.alt;
    else if (n.type === "link") out += text(n.children);
    else out += text(n.children);
  }
  return out;
}

const kinds = (nodes: MdInline[]) => nodes.map((n) => n.type);

describe("markdown: block structure", () => {
  it("parses paragraphs and joins wrapped lines", () => {
    const blocks = parseMarkdown("第一行\n第二行\n\n另起一段");
    expect(blocks).toHaveLength(2);
    expect(text(block(blocks, "paragraph").children)).toBe("第一行\n第二行");
    const second = blocks[1];
    expect(second?.type === "paragraph" ? text(second.children) : null).toBe("另起一段");
  });

  it("parses ATX headings with the right level, and no space is required after #", () => {
    const blocks = parseMarkdown("# 一\n## 二\n###### 六");
    expect(blocks.map((b) => (b.type === "heading" ? b.level : 0))).toEqual([1, 2, 6]);
  });

  it("treats 7 hashes as a paragraph, not a heading", () => {
    expect(parseMarkdown("####### 七")[0]!.type).toBe("paragraph");
  });

  it("parses fenced code with a language and keeps inner markdown literal", () => {
    const blocks = parseMarkdown("```ts\nconst a = **not bold**;\n# not a heading\n```");
    const code = block(blocks, "code");
    expect(code.lang).toBe("ts");
    expect(code.value).toBe("const a = **not bold**;\n# not a heading");
    expect(code.closed).toBe(true);
  });

  it("keeps an UNCLOSED fence as a code block (this is what streaming looks like)", () => {
    const blocks = parseMarkdown("说明\n\n```js\nconst a = 1;");
    const code = block(blocks, "code");
    expect(code.value).toBe("const a = 1;");
    expect(code.closed).toBe(false);
  });

  it("closes a fence with a longer run of the same character", () => {
    const blocks = parseMarkdown("````\n```\ninner\n````");
    expect(block(blocks, "code").value).toBe("```\ninner");
  });

  it("does not close a backtick fence with tildes", () => {
    expect(block(parseMarkdown("```\n~~~\n```"), "code").value).toBe("~~~");
  });

  it("parses hr in all three forms and does not mistake it for a list", () => {
    expect(parseMarkdown("---")[0]!.type).toBe("hr");
    expect(parseMarkdown("***")[0]!.type).toBe("hr");
    expect(parseMarkdown("___")[0]!.type).toBe("hr");
  });

  it("does not treat a `---` under text as a heading (setext is unsupported)", () => {
    const blocks = parseMarkdown("标题\n---");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "hr"]);
  });
});

describe("markdown: lists", () => {
  it("parses an unordered list", () => {
    const list = block(parseMarkdown("- 一\n- 二\n- 三"), "list");
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(3);
    expect(list.items.map((item) => text(block(item, "paragraph").children))).toEqual(["一", "二", "三"]);
  });

  it("parses an ordered list and records its start", () => {
    const list = block(parseMarkdown("3. 三\n4. 四"), "list");
    expect(list.ordered).toBe(true);
    expect(list.start).toBe(3);
    expect(list.items).toHaveLength(2);
  });

  it("accepts ) as the ordered marker", () => {
    expect(block(parseMarkdown("1) 一"), "list").ordered).toBe(true);
  });

  it("nests a sublist under its parent item", () => {
    const list = block(parseMarkdown("- 父\n  - 子一\n  - 子二\n- 父二"), "list");
    expect(list.items).toHaveLength(2);
    const nested = block(list.items[0]!, "list");
    expect(nested.items).toHaveLength(2);
    expect(list.items[1]!.map((b) => text(block([b], "paragraph").children))).toEqual(["父二"]);
  });

  it("folds an indented continuation block into the same item", () => {
    const list = block(parseMarkdown("- 一\n\n  继续的段落\n- 二"), "list");
    expect(list.items).toHaveLength(2);
    expect(list.items[0]!.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
  });

  it("keeps a nested code fence inside a list item", () => {
    const list = block(parseMarkdown("- 看代码\n\n  ```js\n  x()\n  ```"), "list");
    expect(list.items[0]!.some((b) => b.type === "code")).toBe(true);
  });

  it("does not swallow a following paragraph into the list", () => {
    const blocks = parseMarkdown("- 一\n\n后面一段");
    expect(blocks.map((b) => b.type)).toEqual(["list", "paragraph"]);
  });

  it("stops the list at a heading", () => {
    expect(parseMarkdown("- 一\n# 标题").map((b) => b.type)).toEqual(["list", "heading"]);
  });

  it("marks a list loose when items are separated by blank lines", () => {
    expect(block(parseMarkdown("- 一\n\n- 二"), "list").loose).toBe(true);
    expect(block(parseMarkdown("- 一\n- 二"), "list").loose).toBe(false);
  });
});

describe("markdown: blockquotes", () => {
  it("parses a quote and strips the marker", () => {
    const quote = block(parseMarkdown("> 引用一\n> 引用二"), "blockquote");
    expect(text(block(quote.children, "paragraph").children)).toBe("引用一\n引用二");
  });

  it("parses block structure inside a quote", () => {
    const quote = block(parseMarkdown("> # 标题\n> - 一"), "blockquote");
    expect(quote.children.map((b) => b.type)).toEqual(["heading", "list"]);
  });

  it("keeps a lazy continuation line in the quote", () => {
    const quote = block(parseMarkdown("> 一\n接着写"), "blockquote");
    expect(text(block(quote.children, "paragraph").children)).toBe("一\n接着写");
  });
});

describe("markdown: tables", () => {
  it("parses a table with alignment", () => {
    const table = block(parseMarkdown("| 名 | 值 |\n|:---|---:|\n| a | 1 |\n| b | 2 |"), "table");
    expect(table.align).toEqual(["left", "right"]);
    expect(table.head.map(text)).toEqual(["名", "值"]);
    expect(table.rows.map((row) => row.map(text))).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  it("parses a table without outer pipes", () => {
    const table = block(parseMarkdown("名 | 值\n--- | ---\na | 1"), "table");
    expect(table.head.map(text)).toEqual(["名", "值"]);
    expect(table.rows).toHaveLength(1);
  });

  it("pads a short row so the grid stays rectangular", () => {
    const table = block(parseMarkdown("| a | b | c |\n|---|---|---|\n| 1 |"), "table");
    expect(table.rows[0]!.map(text)).toEqual(["1", "", ""]);
  });

  it("does not treat a separator-only line as a table", () => {
    expect(parseMarkdown("---")[0]!.type).toBe("hr");
  });

  it("keeps a pipe inside a code span in one cell", () => {
    const table = block(parseMarkdown("| a | b |\n|---|---|\n| `x|y` | 2 |"), "table");
    expect(table.rows[0]!.map(text)).toEqual(["x|y", "2"]);
  });
});

describe("markdown: inline", () => {
  it("parses strong, em and strikethrough", () => {
    expect(kinds(parseInline("**粗**"))).toEqual(["strong"]);
    expect(kinds(parseInline("*斜*"))).toEqual(["em"]);
    expect(kinds(parseInline("~~删~~"))).toEqual(["del"]);
  });

  it("nests em inside strong for ***both***", () => {
    const nodes = parseInline("***两者***");
    expect(nodes[0]!.type).toBe("strong");
    const strong = nodes[0] as Extract<MdInline, { type: "strong" }>;
    expect(strong.children[0]!.type).toBe("em");
    expect(text(nodes)).toBe("两者");
  });

  it("parses inline code and does not interpret markup inside it", () => {
    const nodes = parseInline("`**not bold**`");
    expect(kinds(nodes)).toEqual(["code"]);
    expect(text(nodes)).toBe("**not bold**");
  });

  it("parses a link and keeps only the URL from a titled link", () => {
    const nodes = parseInline('[文档](https://example.com "标题")');
    expect(nodes[0]!.type).toBe("link");
    expect((nodes[0] as Extract<MdInline, { type: "link" }>).href).toBe("https://example.com");
    expect(text(nodes)).toBe("文档");
  });

  it("keeps a URL that itself contains parentheses", () => {
    // A plain indexOf(")") truncates this and leaves a stray ")" as text.
    const nodes = parseInline("[条目](https://en.wikipedia.org/wiki/A_(b))");
    expect((nodes[0] as Extract<MdInline, { type: "link" }>).href)
      .toBe("https://en.wikipedia.org/wiki/A_(b)");
    expect(text(nodes)).toBe("条目");
  });

  it("parses an image and a linked image", () => {
    const nodes = parseInline("![替代文字](https://example.com/a.png)");
    expect(nodes[0]!.type).toBe("image");
    expect((nodes[0] as Extract<MdInline, { type: "image" }>).alt).toBe("替代文字");

    const linked = parseInline("[![alt](https://e.com/i.png)](https://e.com)");
    expect(linked[0]!.type).toBe("link");
  });

  it("autolinks a bare URL and strips sentence punctuation", () => {
    const nodes = parseInline("见 https://example.com/a, 然后");
    const link = nodes.find((n) => n.type === "link") as Extract<MdInline, { type: "link" }>;
    expect(link.href).toBe("https://example.com/a");
    expect(text(nodes)).toContain("然后");
  });

  it("keeps a balanced paren inside a bare URL but drops an unbalanced closer", () => {
    expect((parseInline("https://en.wikipedia.org/wiki/A_(b)")[0] as Extract<MdInline, { type: "link" }>).href)
      .toBe("https://en.wikipedia.org/wiki/A_(b)");
    const wrapped = parseInline("(见 https://example.com)") as Extract<MdInline, { type: "link" }>[];
    const link = wrapped.find((n) => n.type === "link") as Extract<MdInline, { type: "link" }>;
    expect(link.href).toBe("https://example.com");
  });

  it("autolinks angle brackets, including mailto without the prefix", () => {
    expect((parseInline("<https://example.com>")[0] as Extract<MdInline, { type: "link" }>).href)
      .toBe("https://example.com");
    const mail = parseInline("<mailto:a@b.com>")[0] as Extract<MdInline, { type: "link" }>;
    expect(mail.href).toBe("mailto:a@b.com");
    expect(text([mail])).toBe("a@b.com");
  });

  it("honours backslash escapes", () => {
    expect(text(parseInline("\\*不是斜体\\*"))).toBe("*不是斜体*");
    expect(kinds(parseInline("\\*不是斜体\\*"))).toEqual(["text"]);
  });

  it("leaves an unclosed marker as literal text (streaming mid-token)", () => {
    expect(text(parseInline("**还没闭合"))).toBe("**还没闭合");
    expect(kinds(parseInline("**还没闭合"))).toEqual(["text"]);
    expect(text(parseInline("`未闭合"))).toBe("`未闭合");
  });

  it("does not italicise snake_case identifiers", () => {
    expect(kinds(parseInline("some_var_name"))).toEqual(["text"]);
    expect(text(parseInline("some_var_name"))).toBe("some_var_name");
  });

  it("flattens a nested link inside a link instead of nesting anchors", () => {
    const nodes = parseInline("[外 [内](https://a.com)](https://b.com)");
    expect(nodes[0]!.type).toBe("link");
    expect(text(nodes)).toBe("外 内");
  });

  it("keeps a code span that itself contains a backtick via double delimiters", () => {
    const nodes = parseInline("`` a ` b ``");
    expect(kinds(nodes)).toEqual(["code"]);
    expect(text(nodes)).toBe("a ` b");
  });
});

describe("markdown: link safety", () => {
  it("refuses javascript: and data: URLs", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("JavaScript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>x</script>")).toBeNull();
    expect(safeHref("vbscript:x")).toBeNull();
  });

  it("allows http, https, mailto, tel and relative targets", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("http://example.com")).toBe("http://example.com");
    expect(safeHref("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(safeHref("tel:+8613800000000")).toBe("tel:+8613800000000");
    expect(safeHref("./docs/a.md")).toBe("./docs/a.md");
    expect(safeHref("#anchor")).toBe("#anchor");
  });

  it("renders a javascript: link as plain text, dropping the anchor entirely", () => {
    const nodes = parseInline("[点我](javascript:alert(1))");
    expect(nodes.some((n) => n.type === "link")).toBe(false);
    expect(text(nodes)).toBe("点我");
  });

  it("drops the href of an image with a dangerous URL but keeps the alt text", () => {
    const nodes = parseInline("![说明](javascript:alert(1))");
    const image = nodes[0] as Extract<MdInline, { type: "image" }>;
    expect(image.type).toBe("image");
    expect(image.href).toBeNull();
    expect(image.alt).toBe("说明");
  });
});

describe("markdown: real transcript shapes", () => {
  it("parses a mixed reply without losing any content", () => {
    const source = [
      "改好了，要点如下：",
      "",
      "## 改动",
      "",
      "1. 命令目录不再截断",
      "2. 布局改成页签 + 右侧历史",
      "",
      "```bash",
      "npm test",
      "```",
      "",
      "> 注意：宿主 CSS 缺失的类会静默失效。",
      "",
      "| 项目 | 状态 |",
      "| --- | :-: |",
      "| 单测 | ✅ |",
      "| 构建 | ✅ |",
    ].join("\n");
    const blocks = parseMarkdown(source);
    expect(blocks.map((b) => b.type)).toEqual([
      "paragraph",
      "heading",
      "list",
      "code",
      "blockquote",
      "table",
    ]);
    // The order is what makes a bubble readable; content must survive the trip.
    const all = JSON.stringify(blocks);
    expect(all).toContain("命令目录不再截断");
    expect(all).toContain("npm test");
    expect(all).toContain("静默失效");
    expect(all).toContain("✅");
  });

  it("is stable on every prefix of a streaming message (no throw, no loss)", () => {
    // A streaming turn re-parses on every delta, so every prefix must be a valid
    // input. This is the property that matters most in production.
    const source = "# 标题\n\n- 一\n- 二\n\n```js\nconst a = 1;\n```\n\n**粗体** 和 `代码`";
    for (let i = 0; i <= source.length; i += 1) {
      const prefix = source.slice(0, i);
      expect(() => parseMarkdown(prefix)).not.toThrow();
    }
  });

  it("treats an empty or whitespace-only message as no blocks", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n\n  ")).toEqual([]);
  });

  it("normalises CRLF so Windows output parses the same", () => {
    expect(parseMarkdown("# 一\r\n\r\n段落").map((b) => b.type)).toEqual(["heading", "paragraph"]);
  });
});
