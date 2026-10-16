/**
 * Model + reasoning picker.
 *
 * A flat list of provider → model rows rather than a two-level drilldown: the
 * list is short enough that grouping with headers reads faster, and it keeps
 * the current selection visible without navigating.
 */

import { reasoningLabel, REASONING_LEVELS } from "../core/slash";
import type { ModelOptionProvider } from "../app/controller";
import type { HermesPluginSdk } from "./sdk";

export interface ModelPickerProps {
  sdk: HermesPluginSdk;
  open: boolean;
  loading: boolean;
  providers: readonly ModelOptionProvider[];
  currentModel: string;
  currentProvider: string;
  reasoning: string;
  onPick: (model: string, provider: string) => void;
  onPickReasoning: (level: string) => void;
  onClose: () => void;
}

export function ModelPicker(props: ModelPickerProps) {
  const { sdk } = props;
  const { React } = sdk;
  const { useMemo, useState } = sdk.hooks;

  const [filter, setFilter] = useState("");

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return props.providers
      .map((provider) => ({
        provider,
        models: q
          ? provider.models.filter(
              (model) => model.toLowerCase().includes(q) || provider.name.toLowerCase().includes(q),
            )
          : provider.models,
      }))
      .filter((group) => group.models.length > 0);
  }, [props.providers, filter]);

  if (!props.open) return null;

  return React.createElement(
    "div",
    {
      className: "fixed inset-0 z-50 flex items-start justify-center p-8",
      style: { background: "rgba(0,0,0,0.45)" },
      onClick: props.onClose,
    },
    React.createElement(
      "div",
      {
        className: "hb-max-h-70vh flex w-full flex-col overflow-hidden",
        style: {
          maxWidth: "34rem",
          background: "var(--color-card)",
          color: "var(--color-card-foreground)",
          borderRadius: "var(--radius)",
          boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
        },
        onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
      },

      React.createElement(
        "div",
        { className: "flex items-center gap-2 border-b p-3", style: { borderColor: "var(--color-border)" } },
        React.createElement("span", { className: "text-xs font-medium" }, "模型与思考强度"),
        React.createElement(
          "button",
          {
            type: "button",
            className: "ml-auto cursor-pointer px-2 text-sm",
            style: { color: "var(--color-muted-foreground)" },
            onClick: props.onClose,
          },
          "×",
        ),
      ),

      // reasoning row
      React.createElement(
        "div",
        { className: "flex flex-wrap items-center gap-1.5 border-b p-3", style: { borderColor: "var(--color-border)" } },
        React.createElement(
          "span",
          { className: "mr-1 text-[0.6875rem]", style: { color: "var(--color-muted-foreground)" } },
          "思考强度",
        ),
        REASONING_LEVELS.map((level) =>
          React.createElement(
            "button",
            {
              key: level,
              type: "button",
              className: "cursor-pointer px-2 py-0.5 text-[0.6875rem]",
              style: {
                background: level === props.reasoning ? "var(--color-primary)" : "var(--color-muted)",
                color: level === props.reasoning ? "var(--color-primary-foreground)" : "var(--color-foreground)",
                borderRadius: "calc(var(--radius) * 0.6)",
              },
              onClick: () => props.onPickReasoning(level),
            },
            reasoningLabel(level),
          ),
        ),
      ),

      React.createElement("input", {
        value: filter,
        placeholder: "筛选模型…",
        className: "mb-1 bg-transparent px-2 py-1.5 text-xs outline-none",
        style: {
          margin: "0.75rem 0.75rem 0.25rem",
          color: "var(--color-foreground)",
          borderRadius: "calc(var(--radius) * 0.6)",
          boxShadow: "inset 0 0 0 1px var(--color-border)",
        },
        onChange: (event: { target: { value: string } }) => setFilter(event.target.value),
      }),

      React.createElement(
        "div",
        { className: "min-h-0 flex-1 overflow-y-auto p-3 pt-1 hb-scroll" },
        props.loading
          ? React.createElement("div", { className: "py-4 text-center text-xs", style: { color: "var(--color-muted-foreground)" } }, "载入中…")
          : groups.length === 0
            ? React.createElement("div", { className: "py-4 text-center text-xs", style: { color: "var(--color-muted-foreground)" } }, "没有匹配的模型")
            : groups.map((group) =>
                React.createElement(
                  "div",
                  { key: group.provider.slug, className: "mb-2" },
                  React.createElement(
                    "div",
                    {
                      className: "flex items-baseline gap-1.5 px-1 py-1 text-[0.6875rem] uppercase tracking-[0.06em]",
                      style: { color: "var(--color-muted-foreground)" },
                    },
                    group.provider.name || group.provider.slug,
                    group.provider.is_current
                      ? React.createElement("span", { style: { color: "var(--color-primary)" } }, "当前")
                      : null,
                    group.provider.authenticated === false
                      ? React.createElement("span", { style: { color: "var(--color-destructive)" } }, "未配置密钥")
                      : null,
                  ),
                  group.models.map((model) => {
                    const isCurrent = model === props.currentModel && group.provider.slug === props.currentProvider;
                    return React.createElement(
                      "button",
                      {
                        key: `${group.provider.slug}:${model}`,
                        type: "button",
                        className: "flex w-full cursor-pointer items-baseline gap-2 px-2 py-1 text-left text-xs",
                        style: {
                          background: isCurrent ? "var(--color-accent, var(--color-muted))" : "transparent",
                          color: "var(--color-foreground)",
                          borderRadius: "calc(var(--radius) * 0.6)",
                        },
                        onClick: () => props.onPick(model, group.provider.slug),
                      },
                      React.createElement("span", { className: "min-w-0 flex-1 truncate font-mono" }, model),
                      isCurrent ? React.createElement("span", { style: { color: "var(--color-primary)" } }, "✓") : null,
                    );
                  }),
                ),
              ),
      ),
    ),
  );
}
