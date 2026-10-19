"""hermes-bubbles backend routes, mounted at /api/plugins/hermes-bubbles/.

The chat itself needs no backend: the page talks to the dashboard's own
``/api/ws`` JSON-RPC gateway, which is the same socket the desktop app uses.

What this file adds is the capability probe, plus the git probe the workspace
chip needs (the gateway reports a branch and nothing else, and a browser cannot
spawn git). The plugin depends on internal
protocol details (event names, payload fields) that are not covered by any
versioned API, so before the page renders a chat it asks the backend what it
actually speaks and refuses to start on a mismatch, instead of rendering an
empty thread and looking broken.
"""

from __future__ import annotations

import asyncio
import os
import subprocess

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


# ── git ──────────────────────────────────────────────────────────────────────

#: Entry cap for `git status`. A build directory can produce tens of thousands
#: of untracked lines; the badge wants counts, not a listing.
STATUS_LINE_LIMIT = 2000
GIT_TIMEOUT_S = 4.0
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


def _git_env() -> dict[str, str]:
    """Environment that keeps a probe read-only and non-interactive.

    ``GIT_OPTIONAL_LOCKS=0`` stops ``status`` from refreshing the index — a
    status read must not write to the user's repo. ``GIT_TERMINAL_PROMPT=0``
    turns a credentialed remote into an error instead of a prompt nobody sees.
    """
    env = dict(os.environ)
    env["GIT_OPTIONAL_LOCKS"] = "0"
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env


def _git(cwd: str, *args: str) -> str:
    """``git -C <cwd> <args>`` → stdout, or ``""`` when git is missing or failed."""
    try:
        done = subprocess.run(
            ["git", "-C", cwd, *args],
            capture_output=True,
            timeout=GIT_TIMEOUT_S,
            check=False,
            env=_git_env(),
            creationflags=_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):  # no git on PATH, or it hung
        return ""
    if done.returncode != 0:
        return ""
    return done.stdout.decode("utf-8", "replace")


@router.get("/git")
async def git_status(path: str = "") -> dict:
    """Branch + working-tree state for one directory (the workspace chip's badge).

    The gateway's ``config.get`` with ``key="project"`` answers a branch and
    nothing else, so the counts have to come from git directly. This runs where
    the dashboard runs — the machine that actually holds the repo — and returns
    ``status --porcelain=v2 --branch`` verbatim: parsing lives in
    ``src/core/gitinfo.ts``, where it is unit-tested.

    Not a repository ⇒ ``{"ok": true, "is_repo": false}`` and the page renders no
    badge at all, so a plain directory looks exactly like it did before.
    """
    raw = (path or "").strip()
    if not raw:
        return {"ok": False, "is_repo": False, "error": "path required"}
    target = os.path.abspath(os.path.expanduser(raw))
    if not os.path.isdir(target):
        return {"ok": False, "is_repo": False, "error": "not a directory"}

    root = (await asyncio.to_thread(_git, target, "rev-parse", "--show-toplevel")).strip()
    if not root:
        return {"ok": True, "is_repo": False, "path": target}

    status = await asyncio.to_thread(
        _git, target, "status", "--porcelain=v2", "--branch", "--untracked-files=normal"
    )
    lines = status.splitlines()
    truncated = len(lines) > STATUS_LINE_LIMIT
    if truncated:
        lines = lines[:STATUS_LINE_LIMIT]
    return {
        "ok": True,
        "is_repo": True,
        "path": target,
        "root": root.replace("\\", "/"),
        "status": "\n".join(lines),
        "truncated": truncated,
    }

