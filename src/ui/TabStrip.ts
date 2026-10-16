/**
 * The tab strip across the top of the chat area.
 *
 * Open sessions live up here (one tab each); the history of stored sessions is a
 * panel on the right. Splitting the two is deliberate — "what I have open" and
 * "what exists" are different questions, and a single merged list makes it
 * impossible to tell whether clicking a row switches to it or opens a copy.
 */

import { tabLabel, type SessionTab } from "../core/sessions";
import type { HermesPluginSdk } from "./sdk";

export interface TabStripProps {
  sdk: HermesPluginSdk;
  tabs: readonly SessionTab[];
  activeKey: string | null;
  runningKeys: readonly string[];
  historyOpen: boolean;
  onFocus: (key: string) => void;
  onClose: (key: string) => void;
  onNew: () => void;
  onToggleHistory: () => void;
}

export function TabStrip(props: TabStripProps) {
  const { sdk } = props;
  const { React } = sdk;

  return React.createElement(
    "div",
    {
      className: "flex shrink-0 items-stretch gap-1 px-2 py-1.5",
      style: { borderBottom: "1px solid var(--color-border)", minHeight: "2.5rem" },
    },

    // Scrolling tab list: many tabs must not push the buttons off screen.
    React.createElement(
      "div",
      { className: "hb-flex-fill flex items-center gap-1 overflow-x-auto hb-scroll" },
      props.tabs.length === 0
        ? React.createElement(
            "span",
            { className: "hb-text-micro px-2", style: { color: "var(--color-muted-foreground)" } },
            "没有打开的会话",
          )
        : props.tabs.map((tab) =>
            React.createElement(
              "button",
              {
                key: tab.key,
                type: "button",
                title: tabLabel(tab),
                className: "group flex hb-max-w-22ch shrink-0 items-center gap-1.5 px-2.5 py-1 text-xs",
                style: {
                  background: tab.key === props.activeKey ? "var(--color-muted)" : "transparent",
                  color:
                    tab.key === props.activeKey
                      ? "var(--color-card-foreground)"
                      : "var(--color-muted-foreground)",
                  borderRadius: "calc(var(--radius) * 0.6)",
                  boxShadow: tab.key === props.activeKey ? "inset 0 0 0 1px var(--color-border)" : "none",
                },
                onClick: () => props.onFocus(tab.key),
              },
              props.runningKeys.includes(tab.key)
                ? React.createElement("span", { className: "hb-caret shrink-0", style: { color: "var(--color-primary)" } }, "●")
                : null,
              React.createElement("span", { className: "hb-truncate" }, tabLabel(tab)),
              React.createElement(
                "span",
                {
                  role: "button",
                  title: "关闭",
                  className: "hb-tab-close shrink-0 cursor-pointer px-0.5",
                  style: { color: "var(--color-muted-foreground)" },
                  onClick: (event: { stopPropagation: () => void }) => {
                    event.stopPropagation();
                    props.onClose(tab.key);
                  },
                },
                "×",
              ),
            ),
          ),
    ),

    // Actions, pinned right so they never scroll away.
    React.createElement(
      "div",
      { className: "flex shrink-0 items-center gap-1" },
      React.createElement(
        "button",
        {
          type: "button",
          title: "新对话",
          className: "cursor-pointer px-2 py-1 text-sm leading-none",
          style: { color: "var(--color-muted-foreground)" },
          onClick: props.onNew,
        },
        "+",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          title: props.historyOpen ? "收起历史会话" : "展开历史会话",
          className: "cursor-pointer px-2 py-1 text-xs",
          style: {
            color: props.historyOpen ? "var(--color-card-foreground)" : "var(--color-muted-foreground)",
            background: props.historyOpen ? "var(--color-muted)" : "transparent",
            borderRadius: "calc(var(--radius) * 0.6)",
          },
          onClick: props.onToggleHistory,
        },
        "历史",
      ),
    ),
  );
}
