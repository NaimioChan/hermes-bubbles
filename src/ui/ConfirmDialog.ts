/**
 * The accept/cancel control for a switch the gateway refused to apply.
 *
 * `config.set` answers `confirm_required: true` + `confirm_message` instead of
 * switching when a selection guard fires — an expensive model, a provider that
 * trains on your data, or (the case that bites mid-conversation) a large live
 * context carried into a model whose window is smaller. Nothing is written on
 * that reply: the switch only happens when the client re-sends the same pick
 * with `confirm_expensive_model: true`. A client that renders the message as a
 * plain warning leaves the user with no way to say yes, which reads as "the
 * switch silently failed".
 *
 * No hooks here on purpose: it is a leaf that renders from props, so it cannot
 * change its hook count between renders.
 */

import type { HermesPluginSdk } from "./sdk";

export interface ConfirmDialogProps {
  sdk: HermesPluginSdk;
  title: string;
  message: string;
  acceptLabel: string;
  cancelLabel: string;
  onAccept: () => void;
  onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  const { sdk } = props;
  const { React } = sdk;

  return React.createElement(
    "div",
    {
      className: "fixed inset-0 z-50 flex items-start justify-center p-8",
      style: { background: "rgba(0,0,0,0.45)" },
      onClick: props.onCancel,
    },
    React.createElement(
      "div",
      {
        className: "hb-max-h-70vh flex w-full flex-col overflow-hidden",
        "data-hb": "model-confirm",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": props.title,
        style: {
          maxWidth: "32rem",
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
        React.createElement("span", { className: "text-xs font-medium" }, props.title),
        React.createElement(
          "button",
          {
            type: "button",
            "data-hb": "model-confirm-close",
            className: "ml-auto cursor-pointer px-2 text-sm",
            style: { color: "var(--color-muted-foreground)" },
            onClick: props.onCancel,
          },
          "×",
        ),
      ),

      // The backend's message is prose with blank lines between the guard's own
      // text and the switch's warning, so it is rendered as-is, preserving
      // newlines, instead of being flattened into one line.
      React.createElement(
        "div",
        {
          className: "min-h-0 flex-1 overflow-y-auto p-3 text-xs hb-scroll",
          style: { whiteSpace: "pre-wrap", lineHeight: 1.5, color: "var(--color-muted-foreground)" },
        },
        props.message,
      ),

      React.createElement(
        "div",
        { className: "hb-choice-col p-3", style: { borderTop: "1px solid var(--color-border)" } },
        React.createElement(
          "button",
          {
            type: "button",
            "data-hb": "model-confirm-accept",
            className: "hb-action-btn-text hb-choice-row",
            style: {
              background: "var(--color-primary)",
              color: "var(--color-primary-foreground)",
              borderRadius: "calc(var(--radius) * 0.6)",
            },
            onClick: props.onAccept,
          },
          props.acceptLabel,
        ),
        React.createElement(
          "button",
          {
            type: "button",
            "data-hb": "model-confirm-cancel",
            className: "hb-action-btn-text hb-choice-row",
            style: {
              background: "var(--color-muted)",
              color: "var(--color-muted-foreground)",
              borderRadius: "calc(var(--radius) * 0.6)",
            },
            onClick: props.onCancel,
          },
          props.cancelLabel,
        ),
      ),
    ),
  );
}
