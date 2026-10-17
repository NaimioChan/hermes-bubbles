/**
 * The agent's task list, docked above the composer.
 *
 * It is a panel rather than a transcript item because it is not part of the
 * conversation: `todo.updated` sends a whole snapshot that replaces the last
 * one, so a list that lived in the message stream would leave a trail of stale
 * copies. Here one snapshot simply overwrites the previous render.
 *
 * Collapsing is remembered across reloads: a five-item list is useful while a
 * turn runs and noise afterwards, and re-collapsing it every session is the kind
 * of small annoyance that makes a panel feel wrong.
 */

import type { Messages, Locale } from "../core/i18n";
import { messagesFor } from "../core/i18n";
import type { TodoEntry, TodoState } from "../core/types";
import type { HermesPluginSdk } from "./sdk";

const OPEN_STORAGE_KEY = "hb-todo-open";

/** Status glyphs. `in_progress` is the only animated one (see `.hb-todo-active`). */
function glyphFor(status: string): string {
  if (status === "completed") return "✓";
  if (status === "cancelled") return "✕";
  if (status === "in_progress") return "◐";
  return "○";
}

function countDone(todos: readonly TodoEntry[]): number {
  return todos.filter((todo) => todo.status === "completed").length;
}

/**
 * Group into parents and their children.
 *
 * Order comes from the list itself (the backend sorts by priority), and a child
 * whose parent is missing renders as a root rather than disappearing.
 */
function tree(todos: readonly TodoEntry[]): { roots: TodoEntry[]; children: Map<string, TodoEntry[]> } {
  const ids = new Set(todos.map((todo) => todo.id));
  const children = new Map<string, TodoEntry[]>();
  const roots: TodoEntry[] = [];
  for (const todo of todos) {
    if (todo.parent && ids.has(todo.parent)) {
      const bucket = children.get(todo.parent) ?? [];
      bucket.push(todo);
      children.set(todo.parent, bucket);
    } else {
      roots.push(todo);
    }
  }
  return { roots, children };
}

export interface TodoPanelProps {
  sdk: HermesPluginSdk;
  locale: Locale;
  todo: TodoState | null;
}

export function TodoPanel({ sdk, locale, todo }: TodoPanelProps) {
  const { React } = sdk;
  const { useState } = sdk.hooks;
  const t: Messages = messagesFor(locale);
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(OPEN_STORAGE_KEY) !== "off";
    } catch {
      return true;
    }
  });

  // An empty list is not a panel: the store reports one before the agent has
  // planned anything, and a "0 tasks" strip above the composer is pure chrome.
  if (!todo || !todo.todos.length) return null;

  const done = countDone(todo.todos);
  const total = todo.todos.length;
  const { roots, children } = tree(todo.todos);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      window.localStorage.setItem(OPEN_STORAGE_KEY, next ? "on" : "off");
    } catch {
      // Non-fatal: the toggle still works for this session.
    }
  };

  const row = (entry: TodoEntry, depth: number) => {
    const status = entry.status || "pending";
    return React.createElement(
      "div",
      {
        key: entry.id,
        className: depth ? "hb-todo-row hb-todo-child" : "hb-todo-row",
        "data-hb": "todo-row",
        "data-status": status,
      },
      React.createElement(
        "span",
        {
          className: status === "in_progress" ? "hb-todo-glyph hb-todo-active shrink-0" : "hb-todo-glyph shrink-0",
          "aria-hidden": "true",
        },
        glyphFor(status),
      ),
      React.createElement("span", { className: "hb-todo-text" }, entry.content),
    );
  };

  const body = () => {
    const rows: Array<ReturnType<typeof React.createElement>> = [];
    for (const rootEntry of roots) {
      rows.push(row(rootEntry, 0));
      for (const child of children.get(rootEntry.id) ?? []) rows.push(row(child, 1));
    }
    return rows;
  };

  return React.createElement(
    "div",
    { className: "hb-todo-panel", "data-hb": "todo-panel" },
    React.createElement(
      "button",
      {
        type: "button",
        className: "hb-todo-head",
        "data-hb": "todo-toggle",
        "data-open": open ? "true" : "false",
        "aria-expanded": open ? "true" : "false",
        onClick: toggle,
      },
      React.createElement("span", { className: "hb-todo-caret" }, open ? "▾" : "▸"),
      React.createElement("span", { className: "hb-todo-title" }, t.todos),
      React.createElement("span", { className: "hb-todo-count" }, t.todoProgress(done, total)),
    ),
    open
      ? React.createElement("div", { className: "hb-todo-list", role: "list" }, body())
      : null,
  );
}
