/**
 * The dangerous-command approval-mode chip, under the composer.
 *
 * Hermes' approval mode is one of `manual` / `smart` / `off` — how it decides
 * whether to ask before running a guarded (often destructive) terminal command.
 * It is a **profile-scoped** setting, not per-conversation: the gateway has no
 * per-session override, so a change here affects every conversation on this
 * profile. That is why the chip opens a small menu that says so, instead of a
 * silent cycle whose blast radius the user can't see.
 *
 * Pure view: it renders `value` and reports a pick through `onChange`; the page
 * owns the fetch/persist (controller.getApprovalMode / setApprovalMode).
 */

import { approvalModeLabel, messagesFor, type Locale } from "../core/i18n";
import type { HermesPluginSdk } from "./sdk";

export interface ApprovalModeChipProps {
  sdk: HermesPluginSdk;
  locale: Locale;
  /** Current mode; `""` until the first read lands. */
  value: string;
  onChange: (mode: string) => void;
}

/** Display order, safest → loosest. */
const MODES = ["manual", "smart", "off"] as const;

export function ApprovalModeChip(props: ApprovalModeChipProps) {
  const { React } = props.sdk;
  const { useState } = props.sdk.hooks;
  const t = messagesFor(props.locale);

  const [open, setOpen] = useState(false);
  const current = props.value || "smart";
  const label = approvalModeLabel(current, props.locale);

  const close = () => setOpen(false);

  return React.createElement(
    "div",
    { className: "hb-approval-wrap" },

    React.createElement(
      "button",
      {
        type: "button",
        "data-hb": "approval-mode",
        "data-mode": current,
        title: `${t.approvalModeTitle(label)} · ${t.approvalModeHint}`,
        "aria-haspopup": "listbox",
        "aria-expanded": open ? "true" : "false",
        className: "hb-approval-chip",
        style: { color: "var(--color-muted-foreground)" },
        onClick: () => setOpen((v: boolean) => !v),
      },
      React.createElement("span", { className: "hb-approval-caret" }, open ? "\u25BE" : "\u25B8"),
      React.createElement("span", null, t.approvalMode),
      React.createElement("span", { className: "hb-approval-sep" }, "\u00B7"),
      React.createElement("span", { className: "hb-approval-val" }, label),
    ),

    // Click-anywhere-outside to dismiss, without a document listener to tear down.
    open
      ? React.createElement("div", { className: "hb-approval-backdrop", onClick: close })
      : null,

    open
      ? React.createElement(
          "div",
          {
            className: "hb-approval-panel",
            "data-hb": "approval-panel",
            role: "listbox",
          },
          React.createElement("div", { className: "hb-approval-head" }, t.approvalModeHint),
          MODES.map((mode) =>
            React.createElement(
              "button",
              {
                key: mode,
                type: "button",
                "data-hb": "approval-option",
                "data-mode": mode,
                "data-active": mode === current ? "true" : "false",
                role: "option",
                "aria-selected": mode === current ? "true" : "false",
                className: "hb-approval-row",
                style: {
                  background: mode === current ? "var(--color-accent, var(--color-muted))" : "transparent",
                  color: "var(--color-card-foreground)",
                },
                onClick: () => {
                  props.onChange(mode);
                  setOpen(false);
                },
              },
              React.createElement("span", { className: "hb-approval-check" }, mode === current ? "\u2713" : ""),
              React.createElement("span", { className: "hb-approval-row-label" }, approvalModeLabel(mode, props.locale)),
            ),
          ),
        )
      : null,
  );
}
