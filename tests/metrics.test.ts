import { describe, expect, it } from "vitest";

import {
  cacheHitLabel,
  compactNumber,
  contextBar,
  contextBarLabel,
  contextLabel,
  contextPressure,
  costLabel,
  ioLabel,
  metricChips,
  pressureTone,
  tokensPerSecondLabel,
} from "../src/core/metrics";
import { messagesFor } from "../src/core/i18n";
import type { Usage } from "../src/core/types";

const en = messagesFor("en");

const usage: Usage = {
  model: "m",
  input: 1200,
  output: 340,
  total: 1540,
  context_used: 12_300,
  context_max: 200_000,
  context_percent: 6,
  cache_hit_pct: 87,
  avg_tps: 42.4,
  cost_usd: 0.0123,
};

describe("compactNumber", () => {
  it("passes small numbers through", () => {
    expect(compactNumber(999)).toBe("999");
  });

  it("compacts thousands with one decimal below 10k", () => {
    expect(compactNumber(1234)).toBe("1.2k");
    expect(compactNumber(12_300)).toBe("12k");
  });

  it("compacts millions", () => {
    expect(compactNumber(2_500_000)).toBe("2.5M");
  });

  it("is empty for a missing or negative value", () => {
    expect(compactNumber(undefined)).toBe("");
    expect(compactNumber(-5)).toBe("");
  });
});

describe("contextLabel", () => {
  it("renders used over max", () => {
    expect(contextLabel(usage)).toBe("12k/200k");
  });

  it("marks an estimated value", () => {
    expect(contextLabel({ ...usage, context_estimated: true })).toBe("~12k/200k");
  });

  it("falls back to the total when there is no budget", () => {
    expect(contextLabel({ total: 1500 })).toBe("1.5k tok");
  });

  it("is empty for a null usage", () => {
    expect(contextLabel(null)).toBe("");
  });

  it("is empty when there is nothing to report", () => {
    expect(contextLabel({})).toBe("");
  });
});

describe("contextBar", () => {
  it("fills proportionally", () => {
    expect(contextBar(50, 10)).toBe("▓▓▓▓▓░░░░░");
    expect(contextBar(0, 10)).toBe("░░░░░░░░░░");
    expect(contextBar(100, 10)).toBe("▓▓▓▓▓▓▓▓▓▓");
  });

  it("clamps out-of-range percentages", () => {
    expect(contextBar(200, 4)).toBe("▓▓▓▓");
    expect(contextBar(-10, 4)).toBe("░░░░");
  });

  it("is empty for a missing percent", () => {
    expect(contextBar(undefined)).toBe("");
  });
});

describe("contextBarLabel", () => {
  it("renders the bar with the percentage", () => {
    expect(contextBarLabel(usage)).toBe("[▓░░░░░░░░░] 6%");
  });

  it("is empty without a context budget", () => {
    expect(contextBarLabel({ total: 5 })).toBe("");
  });
});

describe("cacheHitLabel", () => {
  it("rounds the percentage", () => {
    expect(cacheHitLabel(usage)).toBe("87%");
  });

  it("is empty when the provider reported no cache reads", () => {
    expect(cacheHitLabel({ total: 5 })).toBe("");
    expect(cacheHitLabel(null)).toBe("");
  });
});

describe("tokensPerSecondLabel", () => {
  it("rounds the throughput", () => {
    expect(tokensPerSecondLabel(usage)).toBe("42 t/s");
  });

  it("is empty before the first completed call", () => {
    expect(tokensPerSecondLabel({ avg_tps: 0 })).toBe("");
    expect(tokensPerSecondLabel(null)).toBe("");
  });
});

describe("costLabel", () => {
  it("keeps precision for a sub-cent amount", () => {
    expect(costLabel({ cost_usd: 0.0123 })).toBe("$0.0123");
  });

  it("rounds a larger amount to cents", () => {
    expect(costLabel({ cost_usd: 1.234 })).toBe("$1.23");
  });

  it("shows a bare zero as free rather than $0.0000", () => {
    expect(costLabel({ cost_usd: 0 })).toBe("$0");
  });

  it("is empty when cost is unknown", () => {
    expect(costLabel({ total: 1 })).toBe("");
  });
});

describe("ioLabel", () => {
  it("shows the input/output split", () => {
    expect(ioLabel(usage)).toBe("↑1.2k ↓340");
  });

  it("is empty when there is no split to show", () => {
    expect(ioLabel({})).toBe("");
    expect(ioLabel(null)).toBe("");
  });
});

describe("metricChips", () => {
  it("returns the chips that have data, in order", () => {
    expect(metricChips(usage, en).map((c) => c.key)).toEqual(["context", "cache", "tps", "cost"]);
  });

  it("omits chips the backend did not report", () => {
    expect(metricChips({ context_max: 1000, context_percent: 5 }, en).map((c) => c.key)).toEqual(["context"]);
  });

  it("collapses to nothing on a fresh session", () => {
    expect(metricChips(null, en)).toEqual([]);
    expect(metricChips({}, en)).toEqual([]);
  });

  it("gives every chip a tooltip", () => {
    for (const chip of metricChips(usage, en)) {
      expect(chip.title.length).toBeGreaterThan(0);
      expect(chip.label.length).toBeGreaterThan(0);
    }
  });

  it("localizes every tooltip through the catalog", () => {
    const zh = messagesFor("zh");
    const cjk = /[\u4e00-\u9fff]/;
    expect(metricChips(usage, zh).every((c) => cjk.test(c.title))).toBe(true);
    expect(metricChips(usage, en).some((c) => cjk.test(c.title))).toBe(false);
  });
});

describe("pressure", () => {
  it("reports the clamped percentage", () => {
    expect(contextPressure(usage)).toBe(6);
    expect(contextPressure({ context_max: 100, context_percent: 150 })).toBe(100);
  });

  it("is null without a budget", () => {
    expect(contextPressure({ total: 5 })).toBeNull();
    expect(contextPressure(null)).toBeNull();
  });

  it("escalates the tone as the window fills", () => {
    expect(pressureTone(10)).toBe("calm");
    expect(pressureTone(70)).toBe("warn");
    expect(pressureTone(90)).toBe("critical");
    expect(pressureTone(null)).toBe("calm");
  });
});
