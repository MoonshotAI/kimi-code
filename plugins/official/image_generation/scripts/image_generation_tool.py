#!/usr/bin/env python3
"""Generate images through the agent-gw media tools.

Workflow phases exposed as subcommands:

- ``generate``      : create an image from a text description, optionally guided
                      by reference images, and download it to a local file.
- ``image-to-url``  : upload a local image to agent-gw storage and return its
                      public ``signed_url``, usable as a reference image for
                      ``generate``.

Gateway contract (agent-gw Python SDK):

    client.tools.generate_image(
        description, *, ratio=None, resolution=None, background=None,
        reference_image_urls=None,
    ) -> ToolResponse
        response.json() == {"media": {"url": str, "mime_type": str}}

    client.upload_storage(file, *, filename=None, content_type=None) -> dict
        returns {"file_id", ..., "signed_url"}; signed_url is a public URL that
        can be passed as a reference_image_urls entry. (Do NOT use upload_file /
        /v1/files — it proxies OpenGW and returns only a file id, no public URL.)
"""

from __future__ import annotations

import argparse
import importlib.metadata as metadata
import mimetypes
import re
import sys
from pathlib import Path
from typing import Any, List, Optional

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

# Tool-facing string -> proto ImageBackground enum name.
BACKGROUND_ENUM = {
    "opaque": "IMAGE_BACKGROUND_OPAQUE",
    "transparent": "IMAGE_BACKGROUND_TRANSPARENT",
}

OPAQUE_RESOLUTION_RATIOS = {
    "1K": ["1:1", "3:2", "2:3"],
    "2K": ["1:1", "16:9"],
    "4K": ["16:9", "9:16"],
}
OPAQUE_PIXEL_SIZES = {
    "1K": {"1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536"},
    "2K": {"1:1": "2048x2048", "16:9": "2048x1152"},
    "4K": {"16:9": "3840x2160", "9:16": "2160x3840"},
}
RATIOS = list(dict.fromkeys(ratio for ratios in OPAQUE_RESOLUTION_RATIOS.values() for ratio in ratios))
TRANSPARENT_RATIOS = OPAQUE_RESOLUTION_RATIOS["1K"]
RESOLUTIONS = ["1K", "2K", "4K"]
TRANSPARENT_RESOLUTION = "1K"

# mime_type -> output file extension, used to name/repair the download path.
MIME_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
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


def _upload_public_url(client, image_path: str) -> str:
    """Upload a local image to agent-gw storage and return its public signed_url."""
    path = Path(image_path)
    content_type = mimetypes.guess_type(path.name)[0]
    obj = client.upload_storage(path, filename=path.name, content_type=content_type)
    signed_url = obj.get("signed_url") if isinstance(obj, dict) else None
    if not signed_url:
        raise SystemExit(f"upload_storage returned no signed_url for '{image_path}'")
    return signed_url


# --- helpers ------------------------------------------------------------------


def _is_public_url(value: str) -> bool:
    return value.startswith(("http://", "https://"))


def validate_reference_urls(refs: List[str]) -> List[str]:
    """Validate that every reference image is already a public URL.

    The gateway only accepts public ``reference_image_urls`` regardless of where
    the plugin runs (a sandbox or the client's local machine). Local paths are
    rejected here on purpose: convert them first with the ``image-to-url``
    subcommand, then pass the resulting public URL."""
    for ref in refs:
        if not _is_public_url(ref):
            raise SystemExit(
                f"reference image must be a public URL, got '{ref}'. "
                f"Convert a local image first with: image-to-url --image-path '{ref}'"
            )
    return list(refs)


def _validate(ratio: str, resolution: str, background: str, output: Path) -> None:
    if ratio not in RATIOS:
        raise SystemExit(f"ratio must be one of {RATIOS}, got '{ratio}'")
    if resolution not in RESOLUTIONS:
        raise SystemExit(f"resolution must be one of {RESOLUTIONS}, got '{resolution}'")
    if background not in BACKGROUND_ENUM:
        raise SystemExit(
            f"background must be one of {list(BACKGROUND_ENUM)}, got '{background}'"
        )
    ext = output.suffix.lower()
    if ext not in (".jpg", ".jpeg", ".png"):
        raise SystemExit("output file must end with .jpg, .jpeg, or .png")
    if background == "transparent":
        if ratio not in TRANSPARENT_RATIOS:
            raise SystemExit(
                f"transparent background only supports ratios {TRANSPARENT_RATIOS}, got '{ratio}'"
            )
        if resolution != TRANSPARENT_RESOLUTION:
            raise SystemExit(
                f"transparent background only supports {TRANSPARENT_RESOLUTION} resolution"
            )
        if ext != ".png":
            raise SystemExit("transparent background only supports PNG output")
    else:
        allowed_ratios = OPAQUE_RESOLUTION_RATIOS[resolution]
        if ratio not in allowed_ratios:
            raise SystemExit(
                f"opaque background at {resolution} only supports ratios {allowed_ratios}, "
                f"got '{ratio}'"
            )


def _download(url: str, output: Path, mime_type: Optional[str]) -> Path:
    """Download ``url`` to ``output``; fix the extension to match mime_type."""
    import subprocess

    target = output
    if mime_type:
        wanted = MIME_EXT.get(mime_type.lower())
        if wanted and target.suffix.lower() not in (wanted, ".jpeg" if wanted == ".jpg" else wanted):
            target = target.with_suffix(wanted)
    target.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        ["curl", "-fsSL", url, "-o", str(target)],
        timeout=CURL_TIMEOUT,
    )
    if proc.returncode != 0:
        raise SystemExit(f"failed to download generated image from {url}")
    return target


# --- subcommands --------------------------------------------------------------


def image_to_url(args: argparse.Namespace) -> int:
    agent_gw_client, agent_gw_error = _client_cls()
    try:
        with agent_gw_client(timeout=DEFAULT_TIMEOUT) as client:
            url = _upload_public_url(client, args.image_path)
    except agent_gw_error as exc:
        print(f"Error uploading image '{args.image_path}': {exc}", file=sys.stderr)
        return 1
    print(url)
    return 0


def generate(args: argparse.Namespace) -> int:
    output = Path(args.output)
    _validate(args.ratio, args.resolution, args.background, output)
    reference_urls = validate_reference_urls(args.reference_image or [])

    agent_gw_client, agent_gw_error = _client_cls()
    try:
        with agent_gw_client(timeout=DEFAULT_TIMEOUT) as client:
            resp = client.tools.generate_image(
                args.description,
                ratio=args.ratio,
                resolution=args.resolution,
                background=BACKGROUND_ENUM[args.background],
                reference_image_urls=reference_urls or None,
                timeout=DEFAULT_TIMEOUT,
            )
            url, mime_type = _media_url_and_mime(resp)
    except agent_gw_error as exc:
        print(f"Error generating image: {exc}", file=sys.stderr)
        return 1

    if not url:
        print("generate_image returned no media URL", file=sys.stderr)
        return 1
    saved = _download(url, output, mime_type)

    print(f"Saved generated image to: {saved}")
    print(
        "Now display it to the user by calling the readFile tool on that path. "
        "Reading the image to show it is the model's job, not this plugin's."
    )
    return 0


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

    gen = subparsers.add_parser("generate", help="Generate an image from a text description")
    gen.add_argument("--description", required=True, help="Text description of the image")
    gen.add_argument("--ratio", default="1:1", choices=RATIOS)
    gen.add_argument("--resolution", default="1K", choices=RESOLUTIONS)
    gen.add_argument("--background", default="opaque", choices=list(BACKGROUND_ENUM))
    gen.add_argument(
        "--reference-image",
        action="append",
        metavar="PUBLIC_URL",
        help="Public reference image URL; repeat for multiple references. "
        "Local images must be converted with the image-to-url subcommand first.",
    )
    gen.add_argument(
        "--output",
        required=True,
        help="Local output file path ending with .jpg, .jpeg, or .png",
    )
    gen.set_defaults(func=generate)

    to_url = subparsers.add_parser(
        "image-to-url", help="Upload a local image to storage and print its public URL"
    )
    to_url.add_argument("--image-path", required=True, help="Local image file path")
    to_url.set_defaults(func=image_to_url)

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
