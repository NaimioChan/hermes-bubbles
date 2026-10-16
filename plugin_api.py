"""hermes-bubbles backend routes, mounted at /api/plugins/hermes-bubbles/.

The chat itself needs no backend: the page talks to the dashboard's own
``/api/ws`` JSON-RPC gateway, which is the same socket the desktop app uses.

What this file adds is the capability probe. The plugin depends on internal
protocol details (event names, payload fields) that are not covered by any
versioned API, so before the page renders a chat it asks the backend what it
actually speaks and refuses to start on a mismatch, instead of rendering an
empty thread and looking broken.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()

#: Protocol facts this bundle was written against (see docs/01-protocol-contract.md).
REQUIRED_METHODS = ("session.create", "session.resume", "session.list", "prompt.submit", "session.interrupt")
REQUIRED_EVENTS = ("message.start", "message.delta", "message.complete", "tool.start", "tool.complete")


def _contract_tables() -> tuple[set[str], set[str], set[str]]:
    """Method, event and server-request names the running backend declares.

    Read from ``tui_gateway.contracts.registry``, which is populated at import
    time and is what the gateway itself validates every frame against — so a
    name missing here is genuinely not on the wire.
    """
    from tui_gateway.contracts import registry

    return set(registry.METHODS), set(registry.EVENTS), set(registry.SERVER_REQUESTS)


@router.get("/capabilities")
async def capabilities() -> dict:
    """Report whether the running backend still speaks what this plugin needs."""
    try:
        methods, events, server_requests = _contract_tables()
    except Exception as exc:  # health: the dashboard must still render on a broken probe
        return {
            "ok": False,
            "error": f"无法读取后端契约表：{exc}",
            "missing_methods": list(REQUIRED_METHODS),
            "missing_events": list(REQUIRED_EVENTS),
        }

    missing_methods = [name for name in REQUIRED_METHODS if name not in methods]
    missing_events = [name for name in REQUIRED_EVENTS if name not in events]

    try:
        from hermes_cli.config import load_config

        version = str(load_config().get("version") or "")
    except Exception:  # health: version is informational only
        version = ""

    return {
        "ok": not missing_methods and not missing_events,
        "version": version,
        "missing_methods": missing_methods,
        "missing_events": missing_events,
        "server_requests": sorted(server_requests),
        "method_count": len(methods),
        "event_count": len(events),
    }
