/**
 * Two views of the same file: the staging tray under the composer, and the row
 * inside a message that has already been sent.
 *
 * They are one module because they must agree — a photo the tray showed as a
 * 56px square must come back as the same square after sending, and a document
 * the tray called `notes.txt` must not turn into a generic "file" afterwards.
 *
 * What can be shown where:
 *
 *   - a local pick has an object URL (`preview`), so image and video both get a
 *     real thumbnail;
 *   - a transcript read back from the store has refs and names but no pixels —
 *     the gateway keeps the upload on the host, and `/api/media` only serves
 *     image suffixes out of the profile's media roots. So those render as a
 *     labelled tile with their kind glyph, not as a broken <img>.
 */

import {
  attachmentPercent,
  formatBytes,
  isPreviewable,
  type Attachment,
  type MessageAttachment,
} from "../core/attachments";
import { messagesFor, type Locale } from "../core/i18n";
import type { HermesPluginSdk } from "./sdk";
import { Icon, type IconName } from "./icons";

function kindIcon(kind: MessageAttachment["kind"]): IconName {
  if (kind === "image") return "image";
  if (kind === "video") return "video";
  return "file";
}

function kindLabel(item: MessageAttachment, t: ReturnType<typeof messagesFor>): string {
  if (item.kind === "image") return t.imageAttachment;
  if (item.kind === "video") return t.videoAttachment;
  return t.attachmentsLabel;
}

/* ── the staging tray ─────────────────────────────────────────────────────── */

export interface AttachmentTrayProps {
  sdk: HermesPluginSdk;
  locale: Locale;
  items: readonly Attachment[];
  onRemove: (id: string) => void;
}

/**
 * Files picked but not sent.
 *
 * Each entry says where the staging is. Reading the file off disk reports a real
 * percentage; the JSON-RPC upload that follows is a single frame with no
 * progress channel, so it shows an indeterminate sweep instead of a fake number.
 * That distinction matters over a remote dashboard (`hermes.naimio.online`),
 * where the upload is where the seconds actually go: before this, a picked file
 * sat as "…" with nothing to say whether it was working or stuck.
 */
export function AttachmentTray(props: AttachmentTrayProps) {
  const { sdk } = props;
  const { React } = sdk;
  const t = messagesFor(props.locale);
  if (!props.items.length) return null;

  return React.createElement(
    "div",
    { className: "hb-att-tray", "data-hb": "attachment-tray" },
    ...props.items.map((item) => {
      const percent = attachmentPercent(item);
      const staging = item.status === "staging";
      const phase = item.phase === "reading" ? t.attachReading : t.attachUploading;
      const previewable = isPreviewable(item.kind) && Boolean(item.previewUrl);

      return React.createElement(
        "span",
        {
          key: item.id,
          className: "hb-att-chip",
          "data-hb": "attachment-chip",
          "data-status": item.status,
          "data-kind": item.kind,
          title: item.error || `${item.name}${item.size ? ` · ${formatBytes(item.size)}` : ""}`,
        },

        previewable
          ? React.createElement("img", { className: "hb-att-thumb", src: item.previewUrl, alt: "" })
          : React.createElement(
              "span",
              { className: "hb-att-glyph" },
              Icon(sdk, { name: kindIcon(item.kind), size: 16 }),
            ),

        React.createElement(
          "span",
          { className: "hb-att-meta" },
          React.createElement("span", { className: "hb-att-name hb-truncate" }, item.name),
          React.createElement(
            "span",
            { className: "hb-att-sub" },
            item.status === "error"
              ? React.createElement("span", { className: "hb-att-error" }, item.error || t.genericError)
              : staging
                ? React.createElement(
                    "span",
                    { className: "hb-att-phase" },
                    percent === null ? phase : `${phase} ${percent}%`,
                  )
                : formatBytes(item.size),
          ),
        ),

        // The progress bar sits under the chip's content, full width.
        staging
          ? React.createElement(
              "span",
              {
                className: percent === null ? "hb-att-bar hb-att-bar-indeterminate" : "hb-att-bar",
                "data-hb": "attachment-progress",
                "data-percent": percent === null ? "" : String(percent),
                "aria-hidden": "true",
              },
              percent === null
                ? null
                : React.createElement("span", { className: "hb-att-bar-fill", style: { width: `${percent}%` } }),
            )
          : null,

        // Removing a file while its bytes are in flight would stage it anyway;
        // the control stays enabled so a stuck upload can still be cleared.
        React.createElement(
          "button",
          {
            type: "button",
            className: "hb-att-remove",
            "data-hb": "attachment-remove",
            title: t.delete,
            "aria-label": `${t.delete}: ${item.name}`,
            onClick: () => props.onRemove(item.id),
          },
          Icon(sdk, { name: "close", size: 13 }),
        ),
      );
    }),
  );
}

/* ── the sent message's attachment row ────────────────────────────────────── */

export interface MessageAttachmentsProps {
  sdk: HermesPluginSdk;
  locale: Locale;
  items: readonly MessageAttachment[];
  /** Right-aligned, the way the user's own bubble is. */
  alignEnd?: boolean;
}

export function MessageAttachments(props: MessageAttachmentsProps) {
  const { sdk } = props;
  const { React } = sdk;
  const t = messagesFor(props.locale);
  if (!props.items.length) return null;

  return React.createElement(
    "div",
    {
      className: props.alignEnd ? "hb-msg-atts hb-msg-atts-end" : "hb-msg-atts",
      "data-hb": "message-attachments",
    },
    ...props.items.map((item, index) => {
      const tile = isPreviewable(item.kind);
      const label = item.name || kindLabel(item, t);
      return React.createElement(
        "div",
        {
          key: `${item.name}-${index}`,
          className: tile ? "hb-msg-att hb-msg-att-tile" : "hb-msg-att",
          "data-hb": "message-attachment",
          "data-kind": item.kind,
          title: item.size ? `${label} · ${formatBytes(item.size)}` : label,
        },
        item.preview && item.kind === "image"
          ? React.createElement("img", { className: "hb-msg-att-image", src: item.preview, alt: label })
          : item.preview && item.kind === "video"
            ? React.createElement(
                "span",
                { className: "hb-msg-att-video" },
                // `preload="metadata"` paints the first frame without pulling
                // the whole clip; no controls — this is a thumbnail, not a player.
                React.createElement("video", { src: item.preview, preload: "metadata", muted: true }),
                React.createElement("span", { className: "hb-msg-att-play" }, Icon(sdk, { name: "video", size: 14 })),
              )
            : React.createElement(
                "span",
                { className: "hb-msg-att-glyph" },
                Icon(sdk, { name: kindIcon(item.kind), size: 15 }),
              ),
        tile
          ? null
          : React.createElement(
              "span",
              { className: "hb-msg-att-name hb-truncate" },
              label,
            ),
      );
    }),
  );
}
