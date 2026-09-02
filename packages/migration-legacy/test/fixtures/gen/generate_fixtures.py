"""Regenerate the golden migration fixtures using kimi-cli's real serializers.

The committed fixtures under `../golden/` are produced by THIS script against a
kimi-cli checkout, so the migration tests exercise the exact byte shapes the
old CLI writes (config via `save_config`, sessions via kosong `Message` /
`save_session_state`, metadata via `Metadata`), plus the historical formats
kimi-cli itself still upgrades (`config.json`, flat `<uuid>.jsonl` sessions,
`metadata.json`, title-only sessions).

Usage (from the kimi-code repo):

    cd ../../../kimi-cli && uv run python \
        /path/to/kimi-code/packages/migration-legacy/test/fixtures/gen/generate_fixtures.py

`--out` defaults to the sibling `golden/` directory next to this script.
Re-run and commit the result whenever kimi-cli's on-disk formats change.
"""

import argparse
import json
from hashlib import md5
from pathlib import Path

from kimi_cli.config import (
    Config,
    LLMModel,
    LLMProvider,
    LoopControl,
    OAuthRef,
    save_config,
)
from kimi_cli.hooks.config import HookDef
from kimi_cli.metadata import Metadata, WorkDirMeta
from kimi_cli.session_state import SessionState, TodoItemState, save_session_state
from kosong.message import (
    AudioURLPart,
    ImageURLPart,
    Message,
    TextPart,
    ThinkPart,
    ToolCall,
    VideoURLPart,
)

WORK_DIR = "/work/golden-proj"
REMOTE_WORK_DIR = "/remote/golden-proj"

UUID_RICH = "11111111-aaaa-4bbb-8ccc-111111111111"
UUID_METADATA = "22222222-aaaa-4bbb-8ccc-222222222222"
UUID_TITLE_ONLY = "33333333-aaaa-4bbb-8ccc-333333333333"
UUID_FLAT = "44444444-aaaa-4bbb-8ccc-444444444444"
UUID_REMOTE = "55555555-aaaa-4bbb-8ccc-555555555555"

WIRE_MTIME = 1_735_689_600.0


def msg(message: Message) -> str:
    return message.model_dump_json(exclude_none=True)


def marker(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False)


def write_lines(path: Path, lines: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_config() -> Config:
    return Config(
        default_model="golden-main",
        theme="dark",
        default_editor="code --wait",
        merge_all_available_skills=True,
        extra_skill_dirs=["/work/extra-skills"],
        providers={
            "managed:kimi-code": LLMProvider(
                type="kimi",
                base_url="https://api.example.test/coding/v1",
                api_key="sk-golden-managed",
                oauth=OAuthRef(storage="file", key="oauth/kimi-code"),
            ),
            "vllm": LLMProvider(
                type="openai_legacy",
                base_url="https://vllm.example.test/v1",
                api_key="EMPTY",
                reasoning_key="reasoning",
            ),
            "genai": LLMProvider(
                type="google_genai",
                base_url="https://genai.example.test/v1beta",
                api_key="sk-golden-genai",
            ),
            "vx": LLMProvider(
                type="vertexai",
                base_url="https://vx.example.test/v1",
                api_key="sk-golden-vx",
            ),
        },
        models={
            "golden-main": LLMModel(
                provider="managed:kimi-code",
                model="kimi-for-coding",
                max_context_size=262144,
                capabilities={"image_in", "thinking"},
            ),
            "vllm-mooncake": LLMModel(
                provider="vllm",
                model="mooncake-v1",
                max_context_size=131072,
            ),
        },
        loop_control=LoopControl(max_retries_per_step=5, reserved_context_size=60000),
        hooks=[HookDef(event="PreToolUse", command="echo golden-hook", matcher="Shell")],
        telemetry=True,
    )


def write_session_dir(
    session_dir: Path,
    context_lines: list[str],
    wire_lines: list[str] | None,
    state: SessionState,
) -> None:
    write_lines(session_dir / "context.jsonl", context_lines)
    if wire_lines is not None:
        write_lines(session_dir / "wire.jsonl", wire_lines)
    session_dir.mkdir(parents=True, exist_ok=True)
    save_session_state(state, session_dir)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "golden")
    args = parser.parse_args()
    out: Path = args.out
    home = out / ".kimi"
    home.mkdir(parents=True, exist_ok=True)

    save_config(build_config(), config_file=home / "config.toml")

    (home / "mcp.json").write_text(
        json.dumps(
            {
                "mcpServers": {
                    "golden-stdio": {
                        "command": "npx",
                        "args": ["golden-mcp@latest"],
                        "env": {"GOLDEN_KEY": "golden-value"},
                    },
                    "golden-remote": {
                        "url": "https://mcp.example.test/mcp",
                        "transport": "http",
                        "auth": "oauth",
                    },
                }
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    metadata = Metadata(
        work_dirs=[
            WorkDirMeta(path=WORK_DIR, last_session_id=UUID_RICH),
            WorkDirMeta(path=REMOTE_WORK_DIR, kaos="ssh"),
        ]
    )
    (home / "kimi.json").write_text(
        json.dumps(metadata.model_dump(mode="json"), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    history_dir = home / "user-history"
    write_lines(
        history_dir / f"{md5(WORK_DIR.encode()).hexdigest()}.jsonl",
        [marker({"content": "ls -la"}), marker({"content": "git status"})],
    )

    skill = home / "skills" / "golden-skill"
    skill.mkdir(parents=True, exist_ok=True)
    (skill / "SKILL.md").write_text(
        "---\nname: golden-skill\ndescription: Golden fixture skill\n---\n\nBody.\n",
        encoding="utf-8",
    )

    credentials = home / "credentials"
    credentials.mkdir(parents=True, exist_ok=True)
    (credentials / "kimi-code.json").write_text(
        json.dumps(
            {
                "access_token": "golden-access",
                "refresh_token": "golden-refresh",
                "expires_at": 1_735_000_000.0,
                "expires_in": 3600.0,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    mcp_oauth = home / "mcp-oauth"
    mcp_oauth.mkdir(parents=True, exist_ok=True)
    (mcp_oauth / "mangled-store-entry").write_text("{}", encoding="utf-8")

    bucket = home / "sessions" / md5(WORK_DIR.encode()).hexdigest()

    rich_context = [
        marker({"role": "_system_prompt", "content": "You are an AI agent."}),
        msg(
            Message(
                role="user",
                content=[
                    TextPart(text="Look at these attachments."),
                    ImageURLPart(
                        image_url=ImageURLPart.ImageURL(
                            url="data:image/png;base64,iVBORw0KGgo=", id="img-1"
                        )
                    ),
                    AudioURLPart(
                        audio_url=AudioURLPart.AudioURL(url="data:audio/wav;base64,UklGRg==")
                    ),
                    VideoURLPart(
                        video_url=VideoURLPart.VideoURL(
                            url="https://media.example.test/v.mp4", id="vid-1"
                        )
                    ),
                ],
            )
        ),
        marker({"role": "_checkpoint", "id": 1}),
        msg(
            Message(
                role="assistant",
                content=[
                    ThinkPart(think="thinking about the attachments"),
                    TextPart(text="The diagram shows a pipeline."),
                ],
                tool_calls=[
                    ToolCall(
                        id="call-1",
                        function=ToolCall.FunctionBody(
                            name="Shell", arguments='{"command": "ls -la"}'
                        ),
                    )
                ],
            )
        ),
        msg(
            Message(
                role="tool",
                content=[TextPart(text="total 0")],
                tool_call_id="call-1",
            )
        ),
        msg(Message(role="assistant", content=[TextPart(text="Done reviewing.")])),
        marker({"role": "_usage", "token_count": 42}),
    ]
    rich_wire = [
        marker({"type": "metadata", "protocol_version": "1.10"}),
        marker(
            {
                "timestamp": WIRE_MTIME,
                "message": {
                    "type": "ToolResult",
                    "payload": {
                        "tool_call_id": "call-1",
                        "return_value": {
                            "is_error": False,
                            "output": "total 0",
                            "message": "",
                            "display": [
                                {"type": "shell", "command": "ls -la", "language": "bash"}
                            ],
                        },
                    },
                },
            }
        ),
    ]
    write_session_dir(
        bucket / UUID_RICH,
        rich_context,
        rich_wire,
        SessionState(
            custom_title="Golden rich session",
            title_generated=False,
            wire_mtime=WIRE_MTIME,
            additional_dirs=["/work/golden-extra"],
            todos=[TodoItemState(title="follow up on the review", status="pending")],
        ),
    )

    metadata_session_dir = bucket / UUID_METADATA
    write_session_dir(
        metadata_session_dir,
        [msg(Message(role="user", content=[TextPart(text="session with legacy metadata")]))],
        None,
        SessionState(),
    )
    (metadata_session_dir / "metadata.json").write_text(
        json.dumps(
            {
                "session_id": UUID_METADATA,
                "title": "Golden legacy title",
                "title_generated": True,
                "title_generate_attempts": 2,
                "wire_mtime": WIRE_MTIME - 100,
                "archived": True,
                "archived_at": WIRE_MTIME + 100,
                "auto_archive_exempt": True,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    title_only_dir = bucket / UUID_TITLE_ONLY
    title_only_dir.mkdir(parents=True, exist_ok=True)
    (title_only_dir / "context.jsonl").write_text("", encoding="utf-8")
    save_session_state(
        SessionState(custom_title="Golden title only", title_generated=False),
        title_only_dir,
    )

    write_lines(
        bucket / f"{UUID_FLAT}.jsonl",
        [
            msg(Message(role="user", content=[TextPart(text="flat era hello")])),
            msg(Message(role="assistant", content=[TextPart(text="flat era answer")])),
        ],
    )

    remote_bucket = (
        home / "sessions" / f"ssh_{md5(REMOTE_WORK_DIR.encode()).hexdigest()}"
    )
    write_session_dir(
        remote_bucket / UUID_REMOTE,
        [msg(Message(role="user", content=[TextPart(text="remote session")]))],
        None,
        SessionState(),
    )

    historical = out / ".kimi-historical-config"
    historical.mkdir(parents=True, exist_ok=True)
    save_config(
        Config(
            default_model="historical-main",
            providers={
                "vllm": LLMProvider(
                    type="openai_legacy",
                    base_url="https://vllm.example.test/v1",
                    api_key="EMPTY",
                ),
            },
            models={
                "historical-main": LLMModel(
                    provider="vllm",
                    model="mooncake-v1",
                    max_context_size=131072,
                ),
            },
        ),
        config_file=historical / "config.json",
    )

    print(f"golden fixtures written to {out}")


if __name__ == "__main__":
    main()
