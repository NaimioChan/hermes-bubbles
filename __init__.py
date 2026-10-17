"""hermes-bubbles: a bubble-style chat page for the Hermes web dashboard.

The plugin is a **dashboard plugin**: the UI bundle lives in ``dashboard/`` and
is discovered by the dashboard's scanner, which walks
``<plugins root>/<name>/dashboard/manifest.json``.

This module exists so the plugin is loadable by Hermes' own plugin loader (and
therefore installable from the plugin catalog). It registers nothing: the chat
page needs no agent tools, hooks or middleware. It talks to the dashboard's
``/api/ws`` JSON-RPC gateway directly, which is the same socket the desktop app
uses, so there is no backend of its own beyond the capability probe in
``dashboard/plugin_api.py``.
"""

from __future__ import annotations


def register(ctx: object) -> None:  # noqa: ARG001 - the loader passes a context we do not use
    """No registrations: this plugin only contributes a dashboard page."""
    return None
