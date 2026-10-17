**hermes-bubbles — a proper chat UI for the web dashboard**

The built-in `/chat` is an xterm.js terminal wired to `/api/pty`, so it renders the TUI character by character: no message boundaries, no formatting, no way to tell where a tool call started or ended.

This plugin replaces it. It doesn't use a PTY — it talks to the dashboard's own `tui_gateway` JSON-RPC socket (`/api/ws`, the same one the desktop app uses), so it gets structured events instead of a character stream. `message.delta` is a token chunk, `tool.start`/`tool.complete` pair up, `approval` needs an answer.

What you get:
- streaming bubbles, Markdown rendered from a node tree (never innerHTML)
- collapsed tool cards with duration
- approval and clarify cards built from the server's own `choices`, one option per line
- session tabs that survive navigating to Config and back
- history panel with open/running lamps, rename and delete
- locator rail down the right edge to jump back to something you said
- mid-turn steering, same as the TUI
- a capability probe that names the missing method instead of an empty thread after `hermes update`

Install (no Node needed, the bundle is committed):

```
hermes plugins install https://github.com/NaimioChan/hermes-bubbles
hermes plugins enable hermes-bubbles
```

Then restart the dashboard, or hit Rescan on the Plugins page.

Not in the official catalog yet, so install prints an "unreviewed source" warning. Expected — it's a plain clone of main.

Two caveats: only `approval` and `clarify` are handled among server→client requests, so sudo/secret/vault prompts return `-32601`. Open tabs survive dashboard navigation, not a full browser reload. MIT.

Repo: https://github.com/NaimioChan/hermes-bubbles

It's mine, and I'd rather hear what breaks on your setup than have it sit quiet. Does the tab/history layout work for how you actually run multi-session? And has anyone hit the JSON-RPC surface drifting on an update?
