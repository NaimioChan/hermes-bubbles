# hermes-bubbles

A bubble-style chat page for the **Hermes** web dashboard (`hermes dashboard`).

The built-in `/chat` is an xterm.js terminal wired to `/api/pty`, running the real TUI — so it looks like a terminal: a character stream, monospace text, no message boundaries. This plugin replaces it with a native message stream where each reply, tool call and approval prompt is its own block, and streaming output grows inside the bubble it belongs to.

It does not go through a PTY. It speaks the dashboard's own `tui_gateway` JSON-RPC socket (`/api/ws`) — the same channel the desktop app uses — so it receives structured events: `message.delta` is a token chunk, `tool.start`/`tool.complete` are a pair to correlate, `approval` is a request that must be answered.

![hermes-bubbles chat page](docs/assets/hero.png)

Open sessions are tabs along the top, stored sessions live in a collapsible panel on the right, and the transcript in the middle holds bubbles, one-line tool rows, collapsible thinking blocks between them, and a locator rail for jumping back to something you said earlier.

## Features

| Feature | Status | Notes |
|---|---|---|
| Streaming bubbles | Done | `message.delta` appends into the current bubble, with a blinking caret while the turn is live |
| Markdown replies | Done | Headings, bold/italic/strikethrough, inline code, fenced blocks with a language label and copy button, nested lists, quotes, rules, tables with alignment. Unclosed fences and lone `**` render as half-finished rather than throwing |
| Tool cards | Done | `tool_id` pairs start/complete; collapsed by default, showing type, summary and duration |
| Task list | Done | `todo.updated` snapshots render as a panel above the composer; collapsible, and the collapsed state is remembered. A tool call seals the reply bubble, so text after a tool starts a new bubble below the card instead of growing the one above it |
| Subagents | Done | One `delegate_task` batch is one card: concurrent children are rows on it, each expanding to its last tool, recent progress and summary |
| Desktop notifications | Done | Pending approvals/clarify (toasts stay until dismissed) and finished turns ring the desktop **only while the window is in the background**; the switch in the tab strip reports permission too, asks for it on click, and pops a confirmation toast; still rings while you are on another dashboard route |
| Composer auto-grow | Done | The input box follows the draft's height (32–192px) and then scrolls, instead of staying one row and hiding everything after the first line |
| Session history | Done | `session.history` projects into the same bubble structure, so a reload keeps the conversation |
| Session management | Done | Rename and delete from the history panel, which also shows a status lamp: lit = open in a tab, pulsing = running |
| Project management | Done | Each project row has a `⋯` menu. An explicit project can be renamed inline (`projects.update`) or deleted for real (`projects.delete`, which drops the entry and its folders but never the sessions or the directory); an auto-discovered repo has no backend row, so it is hidden client-side the way the desktop sidebar does it, with "Show N hidden" to bring it back. The ungrouped bucket gets neither |
| Session as context | Done | Every history row has a ⇩ button, and the row itself can be dragged into the composer: the plugin reads that session's transcript (REST `/api/sessions/{id}/messages`, read-only — it never becomes the active session), folds it into a bounded plain-text block (newest messages first, per-message cap, tool and hidden rows skipped) and puts it in the draft, ready for your own question above/below it |
| Tabs survive navigation | Done | Switch to Config and back — open tabs and in-flight replies are still there |
| Approval & clarify cards | Done | Both render from the server's own `choices`; `multi_select` is joined into the string the wire expects; one option per line. Every clarify question ends with a free-text row (the desktop app's "Other"), mutually exclusive with a single-select pick and additive on multi-select |
| Message actions | Done | Timestamp, branch in new chat, copy, regenerate — matching the desktop app. Every glyph is an inline SVG on one 24-unit grid at one stroke weight (geometry from Lucide, ISC), not a text character: three font glyphs sitting next to each other render at three sizes and three baselines, which is exactly what made the row look uneven |
| History panel | Done | The desktop column and the phone drawer both animate open and shut. The column grows from 0 to its 17rem and gives the width back on close, staying mounted until `hb-panel-out` ends so the exit is a slide rather than a cut |
| Edit a sent message | Done | Edit a user bubble and sending rewrites the turn from there, truncating what followed |
| Mid-turn input | Done | Send while a turn runs; the backend queues, steers or redirects, and the result is reported inline |
| Multi-session | Done | One socket carries several sessions; events are routed by `session_id`, each tab has its own timeline |
| Locator rail | Done | One tick per user message down the right edge; hover to preview, click to jump. Hidden on phones, where it only costs width |
| Mobile / narrow screens | Done | Under 768px the tab strip is REPLACED, not restyled: two round buttons float over the transcript (refresh this chat on the left, a "···" on the right that slides a drawer in from the right edge — no dimming, animated both ways). The drawer's top row starts a new chat, and every session row keeps its three tools behind one "···". The composer is the same control set on both sizes: a "···" menu (model / reasoning / notifications) on the left, round upload and send on the right. Hover-only action rows stay visible and the locator rail is dropped |
| Slash commands | Done | `/` opens a menu; the catalog is fetched once and filtered locally, not truncated |
| Attachments | Done | `+`, drag-drop and paste; routed to `image.attach_bytes` / `pdf.attach` / `file.attach` |
| Model & reasoning | Done | `model.options` listing, session-scoped switching, seven reasoning tiers. A switch the gateway wants confirmed (expensive model, data-policy provider, or a large live context) opens a dialog with the guard's own message and an accept control that re-sends the pick confirmed — nothing is written until you say yes |
| Approval mode | Done | A chip under the composer sets the dangerous-command approval mode (`manual` / `smart` / `off`, `config.set key=approvals.mode`). It is profile-wide — the menu says so — because the backend has no per-conversation override |
| Live metrics | Done | Context bar and percentage, cache hit rate, output speed, cost, updating from `session.usage` |
| Running indicator | Done | A flicking whale tail (animated PNG, the same asset the DeepSeek harness uses) beside the step that is running: the thinking header while reasoning streams, a tool row while it executes. It is an alpha mask over `currentColor`, so it takes the theme's colour; engines without mask support, and users who asked for reduced motion, get the same tail as a static SVG |
| Between two messages | Done | Everything that is not a message — thinking segments, tool calls, delegation batches, machinery notices — is folded into one block per run, capped at 190px and clipped at its bottom edge while collapsed. The header counts what is inside (`▸ 3 thoughts · 8 calls 42s`), the rows stay in the DOM but are `inert` so nothing under the clip can be focused or clicked, and expanding reveals all of them (bounded at 60vh, scrolls inside). A run of one row stays a plain row |
| Interface language | Done | English by default; follows the dashboard's language switch without a reload |

## Requirements

- Hermes Agent web dashboard, tested against **0.22.2**
- Node 20+ to build (developed on 24.21.0)

## Install

The plugin ships as a dashboard plugin, which is a directory layout rather than
a package. There are two paths.

**From a clone** (for development, or if you want the tests):

```bash
git clone https://github.com/NaimioChan/hermes-bubbles
cd hermes-bubbles
npm install --include=dev      # on Windows, NODE_ENV=production silently skips devDependencies
npm test
npm run install-plugin         # builds and copies into $HERMES_HOME/plugins/hermes-bubbles/dashboard/
hermes plugins enable hermes-bubbles
```

**With Hermes' own installer** (needs no Node — the built bundle is committed):

```bash
hermes plugins install https://github.com/NaimioChan/hermes-bubbles
hermes plugins enable hermes-bubbles
```

Either way a user plugin is discovered but **not loaded** until it is named in
`plugins.enabled`. With `hermes plugins enable` that is done for you; otherwise:

```bash
hermes config set plugins.enabled '["hermes-bubbles"]'
curl -H "X-Hermes-Session-Token: <token>" http://127.0.0.1:9119/api/dashboard/plugins/rescan
```

`<token>` is `window.__HERMES_SESSION_TOKEN__` from the dashboard page. No restart
needed. Open `http://127.0.0.1:9119/chat`.

The bundle lives in `dashboard/dist/` and is committed, because the dashboard
scanner only walks `<plugins root>/<name>/dashboard/manifest.json` and a pinned
install runs no build step. After changing the source, `npm run install-plugin`
rewrites both that copy and the installed one, so they never drift.

## How it works

```
src/
├── core/          pure logic — no DOM, no sockets, fully unit-tested
│   ├── types.ts        timeline model (bubbles, tool cards, notices, usage)
│   ├── reduce.ts       events → timeline
│   ├── history.ts      stored rows → timeline
│   ├── context.ts      another session → a bounded prompt block, plus the drag payload
│   ├── sessions.ts     multi-session store: tabs, event routing, history replay
│   ├── markdown.ts     Markdown → node tree (never HTML)
│   ├── rail.ts         locator-rail geometry
│   ├── requests.ts     approval / clarify parsing and answer shaping
│   ├── slash.ts        slash token, completion, dispatch parsing
│   ├── attachments.ts  attachment queue and size/type screening
│   ├── metrics.ts      usage formatting and pressure grading
│   ├── i18n.ts         string catalog and timestamp formatting
│   └── dedupe.ts       cross-socket duplicate gate
├── gateway/       transport
│   ├── channel.ts      JSON-RPC channel (requests, events, server→client requests)
│   └── client.ts       socket lifecycle, reconnect backoff, ensureOpen
├── app/
│   ├── controller.ts   session control: RPC, routing, models, attachments, resync
│   └── persistent.ts   the controller outlives a route change
├── ui/            rendering
│   ├── ChatPage.ts     page skeleton and wiring
│   ├── TabStrip.ts     open sessions
│   ├── HistoryPanel.ts stored sessions, rename/delete, status lamp
│   ├── Composer.ts     input, slash menu, attachment tray, metrics
│   ├── Bubble.ts       bubbles, thinking blocks, tool rows, subagent batches
│   ├── Markdown.ts     renders the node tree via React.createElement
│   ├── LocatorRail.ts  the jump rail
│   ├── RequestCards.ts approval and clarify cards
│   ├── ModelPicker.ts  model and reasoning picker
│   ├── ConfirmDialog.ts  accept/cancel for a switch the gateway held back
│   └── style.css       the small amount of hand-written CSS
└── index.ts       registration entry

plugin.yaml         manifest Hermes' plugin loader reads (and the catalogue requires)
__init__.py         registers nothing; makes the plugin loadable
dashboard/          the layout the dashboard scanner walks — built, committed
```

Nothing in `core/` may reference `window`, `document`, `WebSocket` or `fetch` — that is what makes the edge cases testable. The transport takes an injected socket factory, so tests drive the whole chain with a fake socket.

The protocol is Hermes' internal implementation with no OpenAPI description, so `docs/01-protocol-contract.md` records the version it was verified against (hermes-agent `0.22.2`, commit `d923a5eb487`) and a checklist to re-run after an upgrade.

## Verification

```bash
npm test                  # 553 unit tests, 26 files, no browser
npm run typecheck         # tsc --noEmit
node scripts/verify.mjs   # 93 checks against a real dashboard (needs one on 9119)
node scripts/audit-classes.mjs
```

`npm test` covers event reduction, history projection, multi-session routing, Markdown parsing (including a property check that **every prefix** of a streamed message parses), slash completion, the attachment queue, usage metrics, deduplication, the JSON-RPC channel, and the controller — plus four source-level guards:

- `hook-order` — a hook after an early `return` throws React #310 and blanks the page; neither types nor logic tests can see it.
- `layout-classes` — the plugin renders inside the dashboard's *precompiled* Tailwind bundle, so a class the host never used applies **nothing at all**, silently.
- `theme-vars` — likewise for CSS variables; the host genuinely does not define `--color-foreground` or `--color-background`.
- `architecture` — `core/` stays DOM-free and no component uses `innerHTML`.

`scripts/verify.mjs` drives a real browser against a live gateway: it types, sends, streams, opens menus, switches tabs, renames and deletes sessions, navigates away and back, and measures computed styles. Checks that cannot be meaningful in a given run (the model happened not to emit a code block) report `SKIP` rather than passing vacuously.

`scripts/verify-clarify.mjs` is an on-demand check for the request cards, kept separate because it depends on the model choosing to call `clarify` — a check that depends on that would fail at random.

`scripts/verify-confirm.mjs` covers the confirmation dialog for a held-back model switch. The large-context guard only fires once a session has enough measured context, so the check is on demand: `--edit-config` backs up `config.yaml`, drops `model.switch_context_confirm_tokens` to 1, asserts the cancel and accept paths, then restores the file byte for byte.

## Design notes

**The host's CSS is the floor, not a framework.** The plugin renders inside the dashboard's precompiled stylesheet, which only contains the classes the dashboard's own source used. Anything invented that the host lacks fails silently — no error, no warning, the property just never applies. Three visible bugs came from exactly that (`resize-none`, `max-h-[70vh]`, `text-[0.625rem]`). New styles go into `src/ui/style.css` as explicit `hb-` classes, and `audit-classes.mjs` lists anything that would silently do nothing.

Tag-level host rules intrude too: a global `code { display: inline; color: var(--background) }` lands on the `<code>` inside every `<pre>`, which both shrank code blocks to their text width and painted them near-invisible. Overriding per class is the fix.

**Markdown never becomes HTML.** The parser emits a node tree and the renderer builds elements with `React.createElement`, so text is escaped by React and HTML injection is removed rather than sanitised around. The parser is also built to run on *half a sentence*: every streaming delta re-parses the whole message, so an unclosed fence, a lone `**` or a table whose separator row has not arrived are normal inputs.

**One unit, stated once.** Timeline timestamps are milliseconds everywhere. The backend sends seconds, and exactly one function scales them on the way in. Mixing that up is why a 02:46 turn once displayed as 19:32.

**The controller outlives the page.** Navigating to another dashboard tab unmounts this one. Disposing the controller there would close the socket and every open session, so it is a document-level singleton: unmount releases a reference, remount reuses the instance. A blocking `approval` or `clarify` that arrives while the page is unmounted is parked and replayed, not refused — the backend waits up to an hour for an answer and "the user was on another tab" is not a refusal.

## Compatibility

| | |
|---|---|
| hermes-agent | 0.22.2 (commit `d923a5eb487`) |
| Plugin SDK contract | 1.1.0 |
| Node | 24.21.0 (developed) |
| Bundle | ~180 KiB, React not included |
| Backend route | `/api/plugins/hermes-bubbles/capabilities` |
| `hermes plugins validate` | 14/14 checks pass |
| Catalogue rule 9 | one warning: `plugin_api.py` imports `tui_gateway.contracts.registry` read-only |

The backend route asks once, before the page renders, whether every method and event it needs still exists. When the protocol drifts it fails loudly with the missing names instead of rendering an empty conversation.

## Limitations

- **User plugins must be registered by hand.** The dashboard only loads what is in `plugins.enabled`.
- **Only `approval` and `clarify` are handled** among server→client requests. `sudo`, `secret`, vault prompts and the like get `-32601`, which fails fast rather than hanging — deliberate, but those flows do not work on this page.
- **No protocol version guarantee.** This JSON-RPC surface is an internal implementation and may drift with `hermes update`; the capabilities route is the first gate, the contract document the second.
- **UI state does not survive a full page reload.** Open tabs persist across dashboard navigation, not across a browser refresh.
- **Tool history is lossy.** The backend only carries raw content for `write_file`, `patch` and `skill_manage`; other tools keep a one-line summary.

## License

MIT

---

中文版：[README.zh-CN.md](README.zh-CN.md)
