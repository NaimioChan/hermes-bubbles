import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCALE,
  clockTime,
  formatElapsed,
  LOCALE_STORAGE_KEY,
  messageStamp,
  messagesFor,
  normalizeLocale,
  reasoningLabel,
} from "../src/core/i18n";

describe("i18n: locale resolution", () => {
  it("defaults to English, not the host's Chinese", () => {
    // The plugin's default is English because Hermes ships display.language: en.
    expect(DEFAULT_LOCALE).toBe("en");
    expect(normalizeLocale(null)).toBe("en");
    expect(normalizeLocale(undefined)).toBe("en");
    expect(normalizeLocale("")).toBe("en");
  });

  it("resolves English", () => {
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("EN")).toBe("en");
  });

  it("resolves Chinese, including the traditional and regional tags", () => {
    expect(normalizeLocale("zh")).toBe("zh");
    expect(normalizeLocale("zh-CN")).toBe("zh");
    expect(normalizeLocale("zh-Hant")).toBe("zh");
    expect(normalizeLocale("ZH-tw")).toBe("zh");
  });

  it("treats the host's `auto` as the default", () => {
    // `display.language: auto` is a host value, not a locale: this plugin has no
    // way to know what the host resolved it to, so it uses its own default.
    expect(normalizeLocale("auto")).toBe(DEFAULT_LOCALE);
  });

  it("falls back to English for a language the plugin does not carry", () => {
    // Better a readable English string than a raw key or a blank.
    expect(normalizeLocale("de")).toBe("en");
    expect(normalizeLocale("ja-JP")).toBe("en");
    expect(normalizeLocale("ar")).toBe("en");
  });

  it("reads the dashboard's own storage key", () => {
    expect(LOCALE_STORAGE_KEY).toBe("hermes-locale");
  });
});

describe("i18n: catalog", () => {
  it("ships every key in both languages", () => {
    const en = messagesFor("en");
    const zh = messagesFor("zh");
    // Function-valued entries compare by arity; keys must match exactly, or a
    // language silently renders `undefined`.
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it("has no empty strings", () => {
    for (const locale of ["en", "zh"] as const) {
      const messages = messagesFor(locale) as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(messages)) {
        if (typeof value === "string") expect(value.length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("formats pluralisable strings", () => {
    expect(messagesFor("en").chars(12)).toBe("12 chars");
    expect(messagesFor("zh").chars(12)).toBe("12 字");
    expect(messagesFor("en").minutesAgo(5)).toBe("5 min ago");
    expect(messagesFor("zh").minutesAgo(5)).toBe("5 分钟前");
  });

  it("defaults an unknown locale to the English catalog rather than throwing", () => {
    expect(messagesFor("de" as never).send).toBe("Send");
  });
});

describe("i18n: reasoning labels", () => {
  it("labels every level in both languages", () => {
    expect(reasoningLabel("medium", "en")).toBe("medium");
    expect(reasoningLabel("medium", "zh")).toBe("中");
    expect(reasoningLabel("ultra", "zh")).toBe("极限");
    expect(reasoningLabel("none", "en")).toBe("off");
  });

  it("passes an unknown level through instead of blanking", () => {
    // A backend that adds a tier must degrade to showing the raw name.
    expect(reasoningLabel("mystery", "zh")).toBe("mystery");
    expect(reasoningLabel("mystery", "en")).toBe("mystery");
  });
});

describe("i18n: timestamps", () => {
  // Milliseconds: the timeline's `at` / `completedAt` unit (core/types.ts).
  const at = (iso: string) => new Date(iso).getTime();

  it("treats its input as milliseconds, not seconds", () => {
    // The bug this exists for: callers pass ms (Date.now()) while the formatter
    // assumed seconds and multiplied again, so 02:46 rendered as 19:32.
    const ms = new Date("2026-10-17T02:46:00").getTime();
    expect(clockTime(ms)).toBe("02:46");
    expect(clockTime(ms / 1000)).not.toBe("02:46");
  });

  it("formats a clock as HH:MM, zero-padded", () => {
    expect(clockTime(at("2026-10-17T09:05:00"))).toBe("09:05");
    expect(clockTime(at("2026-10-17T23:59:00"))).toBe("23:59");
  });

  it("returns nothing for a missing or nonsense time rather than 1970", () => {
    expect(clockTime(0)).toBe("");
    expect(clockTime(Number.NaN)).toBe("");
    expect(clockTime(-1)).toBe("");
  });

  it("names today and yesterday, and dates anything older", () => {
    const now = new Date("2026-10-17T12:00:00").getTime();
    expect(messageStamp(at("2026-10-17T09:05:00"), "en", now)).toBe("Today, 09:05");
    expect(messageStamp(at("2026-10-16T09:05:00"), "en", now)).toBe("Yesterday, 09:05");
    expect(messageStamp(at("2026-10-01T09:05:00"), "en", now)).toBe("10/1 09:05");
  });

  it("localizes the day words", () => {
    const now = new Date("2026-10-17T12:00:00").getTime();
    expect(messageStamp(at("2026-10-17T09:05:00"), "zh", now)).toBe("今天 09:05");
    expect(messageStamp(at("2026-10-16T09:05:00"), "zh", now)).toBe("昨天 09:05");
  });
});

describe("i18n: elapsed", () => {
  it("formats sub-second, seconds and minutes", () => {
    expect(formatElapsed(0.25)).toBe("250ms");
    expect(formatElapsed(2.34)).toBe("2.3s");
    expect(formatElapsed(72)).toBe("1m12s");
  });

  it("returns nothing for a nonsense duration", () => {
    expect(formatElapsed(Number.NaN)).toBe("");
    expect(formatElapsed(-3)).toBe("");
  });
});
