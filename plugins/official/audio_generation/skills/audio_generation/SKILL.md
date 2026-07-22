---
name: audio_generation
description: |-
  Generate audio in two ways: text-to-speech, or custom sound effects.

  ### Speech (text-to-speech):
  - High-quality text-to-speech conversion using a selected voice
  - Several pre-built Mandarin voices with different characteristics
  - Use clear, well-formatted text (punctuation helps natural speech)

  ### Sound effects:
  - AI-powered sound effect generation from an English description
  - Customizable duration (0.5 to 22 seconds)
  - Covers ambient, action, musical, foley, emotional, and abstract sounds
  - The description MUST be in English

  ### Usage Guidelines:
  - For speech: pick a voice ID and provide the text to read
  - For sound effects: give a detailed English description and a duration
  - Specify an output path with a .mp3 extension
  - Output is saved locally as mp3
---

# Audio Generation

Use this skill to generate audio. There are two distinct flows — pick the one
that matches the user's intent:

- **Generate speech** (text-to-speech): the user wants spoken audio of some
  text. Use the `speech` flow.
- **Generate sound effects**: the user wants a sound effect / ambience / SFX
  described in words. Use the `sound-effects` flow.

## Setup

Before the first use, ensure the agent-gw Python SDK (version 0.2.6 or newer) is installed. This checks the current environment and installs or upgrades it only when needed:

```bash
python3 "${KIMI_SKILL_DIR}/../../scripts/audio_generation_tool.py" ensure-deps
```

The SDK needs an API key from `api_key=...`, `KIMI_API_KEY`, or
`~/.kimi/agent-gw.json`.

## Choosing the flow

1. If the user wants their **text read aloud / a voiceover / TTS** → **speech**.
2. If the user wants a **sound effect, ambience, music bed, or SFX described in
   words** → **sound-effects**.

Then build the parameters for that flow, run the matching command, and on
success surface the saved mp3 to the user. On failure, explain the error from
the script; do not invent audio or a local path.

## Flow A — Generate speech (text-to-speech)

Parameters:

- `text` (required): the text to convert to speech.
- `voice_id` (required): one of the supported voices below. Default is
  `05Cdh2gw2NMzDvykn1nm`.
- `output` (required): local output path ending in `.mp3`.

Supported voice IDs:

- `05Cdh2gw2NMzDvykn1nm`: calm middle-aged Mandarin male (default)
- `Q63G7WZ5riIGbK8KmqO9`: energetic young Mandarin male
- `NLl76XZRVj1RVeXptX3h`: warm Mandarin female
- `At6gj9vUVdJhTriBsuxE`: cheerful Mandarin female

Best practices: use punctuation and formatting for natural speech, and break
long texts into smaller segments for better quality.

```bash
python3 "${KIMI_SKILL_DIR}/../../scripts/audio_generation_tool.py" speech \
  --text "你好，欢迎使用 Kimi。" \
  --voice-id "05Cdh2gw2NMzDvykn1nm" \
  --output "/path/to/output.mp3"
```

This sends `{"text", "voice_id"}` to the gateway `generate_speech` API.

## Flow B — Generate sound effects

Parameters:

- `description` (required): a detailed description of the sound effect. It
  **MUST be in English** — never use another language.
- `duration` (required): duration in seconds, range `0.5`-`22`.
- `output` (required): local output path ending in `.mp3`.

Duration guidance: short (0.5-3s) for UI sounds/notifications, medium (3-10s)
for ambient loops or action sequences, long (10-22s) for background music or
extended ambience.

```bash
python3 "${KIMI_SKILL_DIR}/../../scripts/audio_generation_tool.py" sound-effects \
  --description "Gentle rain falling on leaves with distant thunder" \
  --duration 8 \
  --output "/path/to/output.mp3"
```

This sends `{"description", "duration_seconds"}` to the gateway
`generate_sound_effects` API.

## After generation

Both flows read `media.url` / `media.mime_type` from the response and download
the audio to your `output` path with `curl` (allowing up to 5 minutes). The
script then prints the saved mp3 path. **Surface that audio to the user** (e.g.
via the `readFile` tool on the path). Playing or reading the audio to present it
is the model's job, not this plugin's work.

## Script summary

The script:

- `speech` validates `voice_id` against the supported list and sends
  `{"text", "voice_id"}` to `generate_speech`
- `sound-effects` validates the duration is within `0.5`-`22` and sends
  `{"description", "duration_seconds"}` to `generate_sound_effects`
- reads the generated `media.url` and `media.mime_type` from the response
- downloads the audio to the `--output` path with `curl` (up to 5 minutes),
  naming the file as `.mp3`
- prints the saved path and a reminder to surface it to the user

Response shape for both APIs (`resp.json()`):

```python
{
    "media": {
        "url": str,        # public URL of the generated audio
        "mime_type": str,  # e.g. "audio/mpeg"
    }
}
```

> This skill uses the agent-gw Python SDK:
> `client.tools.generate_speech(text, voice_id=...)` and
> `client.tools.generate_sound_effects(description, duration_seconds=...)`, with
> the response shape above.
