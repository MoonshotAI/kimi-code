#!/usr/bin/env python3
"""Generate audio through the agent-gw media tools.

Two generation flows, exposed as subcommands:

- ``speech``         : convert text to speech using one of the supported voice
                       IDs, and download the result to a local mp3.
- ``sound-effects``  : create a custom sound effect from an English description
                       and a duration, and download the result to a local mp3.

Gateway contract (agent-gw Python SDK):

    client.tools.generate_speech(text, *, voice_id=None) -> ToolResponse
        response.json() == {"media": {"url": str, "mime_type": str}}

    client.tools.generate_sound_effects(description, *, duration_seconds=None)
        -> ToolResponse
        response.json() == {"media": {"url": str, "mime_type": str}}
"""

from __future__ import annotations

import argparse
import importlib.metadata as metadata
import re
import sys
from pathlib import Path
from typing import Any, Optional

# Audio generation and download can be slow; give them 5 minutes.
DEFAULT_TIMEOUT = 300.0
CURL_TIMEOUT = 300.0
PIP_INSTALL_TIMEOUT = 120.0
MIN_AGENT_GW_VERSION = (0, 2, 6)
MIN_AGENT_GW_VERSION_TEXT = "0.2.6"
AGENT_GW_MANIFEST_URL = "https://cdn.kimi.com/agentgw/pysdk/manifest.json"
# How the skill/user installs the SDK: a readable subcommand rather than an
# inline one-liner. Derived from this script's own filename so it stays correct
# if the plugin is renamed.
ENSURE_DEPS_COMMAND = f"python3 scripts/{Path(__file__).name} ensure-deps"

# Supported voice IDs for text-to-speech -> human-readable description.
VOICES = {
    "05Cdh2gw2NMzDvykn1nm": "calm middle-aged Mandarin male (default)",
    "Q63G7WZ5riIGbK8KmqO9": "energetic young Mandarin male",
    "NLl76XZRVj1RVeXptX3h": "warm Mandarin female",
    "At6gj9vUVdJhTriBsuxE": "cheerful Mandarin female",
}
DEFAULT_VOICE_ID = "05Cdh2gw2NMzDvykn1nm"

SFX_DURATION_MIN = 0.5
SFX_DURATION_MAX = 22.0

# mime_type -> output file extension, used to name/repair the download path.
MIME_EXT = {
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
}


def _client_cls():
    try:
        from agent_gw import AgentGwClient, AgentGwError
    except ModuleNotFoundError as exc:
        raise SystemExit(
            f"Missing dependency: agent-gw >= {MIN_AGENT_GW_VERSION_TEXT}. "
            f"Install it by running: {ENSURE_DEPS_COMMAND}"
        ) from exc
    version = _agent_gw_version()
    if not version or _version_tuple(version) < MIN_AGENT_GW_VERSION:
        found = version or "unknown"
        raise SystemExit(
            f"agent-gw >= {MIN_AGENT_GW_VERSION_TEXT} is required; found {found}. "
            f"Upgrade it by running: {ENSURE_DEPS_COMMAND}"
        )
    return AgentGwClient, AgentGwError


def _agent_gw_version() -> Optional[str]:
    for package_name in ("agent-gw", "agent_gw"):
        try:
            return metadata.version(package_name)
        except metadata.PackageNotFoundError:
            continue
    return None


def _version_tuple(version: str) -> tuple[int, int, int]:
    parts = [int(part) for part in re.findall(r"\d+", version)[:3]]
    parts.extend([0] * (3 - len(parts)))
    return tuple(parts[:3])


def _fetch_latest_wheel_url() -> str:
    """Resolve the latest agent-gw wheel URL from the published CDN manifest."""
    import json
    import subprocess

    proc = subprocess.run(
        ["curl", "-fsSL", AGENT_GW_MANIFEST_URL],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if proc.returncode != 0:
        raise SystemExit(f"failed to fetch the agent-gw manifest from {AGENT_GW_MANIFEST_URL}")
    try:
        url = json.loads(proc.stdout)["latest"]["url"]
    except (ValueError, KeyError, TypeError) as exc:
        raise SystemExit(f"could not read latest.url from {AGENT_GW_MANIFEST_URL}: {exc}")
    if not isinstance(url, str) or not url:
        raise SystemExit(f"the agent-gw manifest at {AGENT_GW_MANIFEST_URL} has no latest.url")
    return url


def _install_agent_gw() -> None:
    """Install or upgrade agent-gw from its latest published wheel."""
    import subprocess

    url = _fetch_latest_wheel_url()
    proc = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-U", "--user", url],
        timeout=PIP_INSTALL_TIMEOUT,
    )
    if proc.returncode != 0:
        raise SystemExit(f"pip failed to install agent-gw from {url}")


def _media_url_and_mime(resp: Any) -> tuple[Optional[str], Optional[str]]:
    """Extract (url, mime_type) from a media-generation ToolResponse."""
    resp.raise_for_status()
    data = resp.json()
    media = data.get("media") if isinstance(data, dict) else None
    if not isinstance(media, dict):
        return None, None
    url = media.get("url")
    mime = media.get("mime_type")
    return (url if isinstance(url, str) else None, mime if isinstance(mime, str) else None)


# --- helpers ------------------------------------------------------------------


def _download(url: str, output: Path, mime_type: Optional[str]) -> Path:
    """Download ``url`` to ``output``; fix the extension to match mime_type."""
    import subprocess

    target = output
    if mime_type:
        wanted = MIME_EXT.get(mime_type.lower())
        if wanted and target.suffix.lower() != wanted:
            target = target.with_suffix(wanted)
    target.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        ["curl", "-fsSL", url, "-o", str(target)],
        timeout=CURL_TIMEOUT,
    )
    if proc.returncode != 0:
        raise SystemExit(f"failed to download generated audio from {url}")
    return target


def _save_and_report(resp: Any, output: Path, kind: str, api: str) -> int:
    url, mime_type = _media_url_and_mime(resp)
    if not url:
        print(f"{api} returned no media URL", file=sys.stderr)
        return 1
    saved = _download(url, output, mime_type)
    print(f"Saved generated {kind} to: {saved}")
    print(
        "Now surface this audio to the user (e.g. via the readFile tool on that "
        "path). Playing or reading the audio is the model's job, not this plugin's."
    )
    return 0


# --- subcommands --------------------------------------------------------------


def speech(args: argparse.Namespace) -> int:
    if args.voice_id not in VOICES:
        allowed = ", ".join(VOICES)
        raise SystemExit(f"voice_id must be one of [{allowed}], got '{args.voice_id}'")
    output = Path(args.output)
    if output.suffix.lower() != ".mp3":
        raise SystemExit("output file must end with .mp3")

    agent_gw_client, agent_gw_error = _client_cls()
    try:
        with agent_gw_client(timeout=DEFAULT_TIMEOUT) as client:
            resp = client.tools.generate_speech(
                args.text, voice_id=args.voice_id, timeout=DEFAULT_TIMEOUT
            )
    except agent_gw_error as exc:
        print(f"Error generating speech: {exc}", file=sys.stderr)
        return 1
    return _save_and_report(resp, output, "speech", "generate_speech")


def sound_effects(args: argparse.Namespace) -> int:
    if not SFX_DURATION_MIN <= args.duration <= SFX_DURATION_MAX:
        raise SystemExit(
            f"duration must be between {SFX_DURATION_MIN} and {SFX_DURATION_MAX} seconds, "
            f"got {args.duration}"
        )
    output = Path(args.output)
    if output.suffix.lower() != ".mp3":
        raise SystemExit("output file must end with .mp3")

    agent_gw_client, agent_gw_error = _client_cls()
    try:
        with agent_gw_client(timeout=DEFAULT_TIMEOUT) as client:
            resp = client.tools.generate_sound_effects(
                args.description, duration_seconds=args.duration, timeout=DEFAULT_TIMEOUT
            )
    except agent_gw_error as exc:
        print(f"Error generating sound effects: {exc}", file=sys.stderr)
        return 1
    return _save_and_report(resp, output, "sound effects", "generate_sound_effects")


def ensure_deps(args: argparse.Namespace) -> int:
    """Ensure agent-gw >= MIN_AGENT_GW_VERSION is installed (the skill's Setup step).

    Checks the current interpreter and only installs/upgrades when needed, so the
    first real call does not fail on a missing or outdated SDK."""
    version = _agent_gw_version()
    if version and _version_tuple(version) >= MIN_AGENT_GW_VERSION:
        print(f"agent-gw {version} already satisfies >= {MIN_AGENT_GW_VERSION_TEXT}.")
        return 0
    if version:
        print(f"agent-gw {version} is older than {MIN_AGENT_GW_VERSION_TEXT}; upgrading...")
    else:
        print(f"agent-gw not found; installing >= {MIN_AGENT_GW_VERSION_TEXT}...")

    _install_agent_gw()

    import importlib

    importlib.invalidate_caches()
    new_version = _agent_gw_version()
    if new_version and _version_tuple(new_version) >= MIN_AGENT_GW_VERSION:
        print(f"agent-gw {new_version} is ready.")
    else:
        # A --user install may not be importable in this already-running process;
        # the next command runs in a fresh process and will pick it up.
        print("agent-gw installed; it will be available to the next command.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    sp = subparsers.add_parser("speech", help="Convert text to speech (text-to-speech)")
    sp.add_argument("--text", required=True, help="Text to convert to speech")
    sp.add_argument(
        "--voice-id",
        default=DEFAULT_VOICE_ID,
        choices=list(VOICES),
        help="Voice ID to use; see SKILL.md for the voice descriptions",
    )
    sp.add_argument("--output", required=True, help="Local output file path ending with .mp3")
    sp.set_defaults(func=speech)

    sfx = subparsers.add_parser(
        "sound-effects", help="Generate a sound effect from an English description"
    )
    sfx.add_argument(
        "--description",
        required=True,
        help="Description of the sound effect; MUST be in English",
    )
    sfx.add_argument(
        "--duration",
        type=float,
        required=True,
        metavar="SECONDS",
        help=f"Duration in seconds ({SFX_DURATION_MIN}-{SFX_DURATION_MAX})",
    )
    sfx.add_argument("--output", required=True, help="Local output file path ending with .mp3")
    sfx.set_defaults(func=sound_effects)

    ensure = subparsers.add_parser(
        "ensure-deps",
        help="Check agent-gw is installed at the required version; install/upgrade if needed",
    )
    ensure.set_defaults(func=ensure_deps)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
