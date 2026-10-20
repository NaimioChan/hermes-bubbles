---
version: alpha
name: Hermes Bubbles
description: A native chat surface inside the Hermes dashboard that repaints with whatever dashboard theme is active.
colors:
  primary: "#ddd6ff"
  secondary: "#7c7ab0"
  tertiary: "#8b80e8"
  neutral: "#08081c"
  surface: "#0d0d28"
  surfaceUser: "#2b2b43"
  surfaceTool: "#19182e"
  onSurface: "#ddd6ff"
  danger: "#fb2c36"
typography:
  body:
    fontFamily: Collapse
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.65
  bubbleLabel:
    fontFamily: Collapse
    fontSize: 0.6875rem
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.06em"
  code:
    fontFamily: Courier Prime
    fontSize: 0.8125rem
    lineHeight: 1.55
rounded:
  sm: 0.45rem
  md: 0.75rem
  lg: 1.2rem
spacing:
  sm: 8px
  md: 16px
  lg: 24px
components:
  bubble-user:
    backgroundColor: "{colors.surfaceUser}"
    textColor: "{colors.onSurface}"
    rounded: "{rounded.lg}"
    padding: 12px
  bubble-assistant:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.onSurface}"
    rounded: "{rounded.lg}"
    padding: 12px
  tool-card:
    backgroundColor: "{colors.surfaceTool}"
    textColor: "{colors.onSurface}"
    rounded: "{rounded.md}"
    padding: 10px
  composer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.onSurface}"
    rounded: "{rounded.md}"
    padding: 10px
  tool-card-body:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.onSurface}"
    rounded: "{rounded.sm}"
    padding: 8px
  notice-error:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
    rounded: "{rounded.sm}"
    padding: 6px
---

## Overview

Hermes Bubbles is a room inside someone else's house. The dashboard ships eight built-in themes and a live theme switcher; a plugin with a hardcoded palette would look like a sticker pasted over the UI and would break the moment the user picked Mono or Rosé.

So the design rule is inverted from a normal design system: **the tokens above are a reference sample, not the source of truth.** They are the values this page renders with when the dashboard is wearing its Midnight theme, which is what the contrast numbers below were measured against. At runtime every one of them is read from a dashboard CSS variable — `--color-card`, `--color-primary`, `--radius`, `--font-sans` — so switching themes repaints this page for free.

The contrast guarantees therefore hold *by construction*, not by these literals. The user bubble is a percentage mix of the theme's own primary into its own card, so it stays legible in every theme; the literals just record what that mix resolves to in one concrete case so the numbers are checkable.

## Colors

The load-bearing decision is the user/assistant asymmetry.

- **surfaceUser (`#2b2b43`)** — the theme's primary mixed 16% into its card. Enough tint to read as "mine" at a glance while `--color-card-foreground` still clears AA on it. Measured in Midnight: **9.90:1**. The 16% is the number that matters; past ~30% it starts failing in the bright themes, and a naive full-primary fill would be **1.00:1** — invisible, because in most themes primary *is* the foreground color.
- **surface (`#0d0d28`)** — plain card. The assistant is the default voice, so it gets the neutral surface and the user's tint reads as the deviation. Measured: **13.46:1**.
- **surfaceTool (`#19182e`)** — muted at 60% into card. Tool output is secondary material and should recede when the user is scanning for their own words.
- **tertiary (`#8b80e8`)** — the ring token, used only as a 2px left stripe on a running tool card. Status is a stripe, not a badge, so a long tool chain stays scannable.
- **danger (`#fb2c36`)** — the destructive token, same stripe treatment for a failed tool, and the text color for a turn-level error. This is the **resolved** value the dashboard's Midnight theme computes, not the raw `#b03060` in its palette source: `--color-destructive` is itself a `color-mix` at render time, and the raw value measures only **3.11:1** on the card (below AA). The resolved one measures **4.99:1**. Read the variable, never the palette literal.

## Typography

Body copy is `--font-sans` at 0.875rem with a 1.65 line-height. Chat is read in motion and tight leading makes streaming text jump as lines reflow.

The bubble label (`你` / `Hermes`) is 0.6875rem, uppercase, 0.06em tracking. It exists so a screen reader and a skimming human both know who is talking without relying on alignment alone — alignment is a weak signal on narrow viewports where bubbles nearly fill the row.

Tool names, arguments, and results use `--font-mono`. Anything a user might copy into a terminal is monospace; anything they read as prose is not.

## Layout

Bubbles cap at `min(72ch, 82%)`. The character cap matters more than the percentage: on a 1600px cockpit layout an 82% bubble is an unreadable 130-character line, and on a 390px phone the character cap never binds.

The user bubble's large radius sits on three corners with a small one on the lower-right; the assistant's mirrors it. That asymmetry is the only decoration — it points at the speaker without an arrow or an avatar.

Spacing between turns is `--spacing-mul`-scaled so the dashboard's compact/comfortable/spacious density setting actually moves this page.

### Narrow screens

The page is also reached from a phone, so below 768px (`src/ui/style.css`, one media block) the layout restructures rather than shrinks: bubbles go full-width (the 72ch cap can never bind on a ~390px screen, and 82% just steals gutter), the composer wraps to two lines so the textarea keeps a usable width, controls grow to the 44px touch minimum, hover-only action rows become permanently visible (touch has no hover — otherwise copy / rename / delete are unreachable), the history panel turns into a bottom sheet over a dimmed backdrop, and the locator rail is dropped. It is all width-based CSS, so one bundle serves both.

## Elevation & Depth

There are no shadows and no elevation steps. Depth is carried by the two-tone surface split (card vs. tinted card) and by a 1px inset ring in `--color-border` on the assistant bubble only. In a terminal-adjacent UI, stacked shadows read as clutter.

## Components

**bubble-user** — right-aligned, tinted, large radius on three corners.

**bubble-assistant** — left-aligned, neutral card, 1px inset ring, mirrored radius. A blinking caret sits at the end of the text while the turn is live: without it a slow first token reads as a hang.

**tool-card** — collapsible. Expanded while running, collapsed once complete so a long chain stays scannable. Left status stripe; header shows the tool name plus a one-line summary and duration; body shows arguments and result in monospace.

**composer** — pinned to the bottom, no visible border until focused. Enter sends, Shift+Enter newlines. A stop button replaces send while a turn is live.

## Do's and Don'ts

**Do** read every color, radius, and spacing value from the dashboard's CSS variables. **Do** keep the transcript readable at 390px with no horizontal scrollbar. **Do** make the streaming state visible. **Do** re-measure contrast after changing the user-bubble mix percentage.

**Don't** invent a palette or hardcode a hex value in a component. **Don't** add avatars, per-row timestamps, or a typing indicator that animates forever. **Don't** render a tool result as one unwrapped line. **Don't** use `!important` to fight the host stylesheet — if a host rule wins, the variable you picked is wrong.
