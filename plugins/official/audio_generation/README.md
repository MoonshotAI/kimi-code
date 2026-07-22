# Audio Generation Kimi Plugin

This plugin bundles a Kimi skill and helper script for generating audio through
the `agent-gw` audio tools. It has two flows: text-to-speech and sound effects.

## Contents

- `kimi.plugin.json`: catalog manifest for the Kimi plugin.
- `skills/audio_generation/SKILL.md`: model instructions for choosing the flow,
  selecting parameters, and surfacing the result.
- `scripts/audio_generation_tool.py`: command-line wrapper around the gateway
  `generate_speech` and `generate_sound_effects` APIs, with result download.

## Local Usage

Before the first use, ensure the agent-gw Python SDK (version 0.2.6 or newer) is installed. This checks the current environment and installs or upgrades it only when needed:

```bash
python3 scripts/audio_generation_tool.py ensure-deps
```

The SDK reads its API key from `api_key=...`, `KIMI_API_KEY`, or
`~/.kimi/agent-gw.json`.

From this plugin directory:

```bash
# Text-to-speech
python3 scripts/audio_generation_tool.py speech \
  --text "你好，欢迎使用 Kimi。" \
  --voice-id "05Cdh2gw2NMzDvykn1nm" \
  --output "/path/to/output.mp3"

# Sound effects (description MUST be in English)
python3 scripts/audio_generation_tool.py sound-effects \
  --description "Gentle rain falling on leaves with distant thunder" \
  --duration 8 \
  --output "/path/to/output.mp3"
```

## Gateway APIs

- `client.tools.generate_speech(text, *, voice_id)` → `resp.json()` =
  `{"media": {"url", "mime_type"}}`.
- `client.tools.generate_sound_effects(description, *, duration_seconds)` →
  `resp.json()` = `{"media": {"url", "mime_type"}}`.

## Catalog

Validate and publish from this directory after connecting to the internal network
and setting `MOONGATE_ACCESS_TOKEN`:

```bash
catalog validate
catalog publish
```
