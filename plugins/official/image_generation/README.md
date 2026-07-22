# Image Generation Kimi Plugin

This plugin bundles a Kimi skill and helper script for creating images from text
descriptions through the `agent-gw` image tools.

## Contents

- `kimi.plugin.json`: catalog manifest for the Kimi plugin.
- `skills/image_generation/SKILL.md`: model instructions for prompting,
  parameter selection, reference-image handling, and displaying the result.
- `scripts/image_generation_tool.py`: command-line wrapper around the gateway
  `generate_image` API and the `upload_storage` API (for turning a local
  reference image into a public URL), with result download.

## Local Usage

Before the first use, ensure the agent-gw Python SDK (version 0.2.6 or newer) is installed. This checks the current environment and installs or upgrades it only when needed:

```bash
python3 scripts/image_generation_tool.py ensure-deps
```

The SDK reads its API key from `api_key=...`, `KIMI_API_KEY`, or
`~/.kimi/agent-gw.json`.

From this plugin directory:

```bash
python3 scripts/image_generation_tool.py generate \
  --description "A serene mountain lake at sunrise, ultra detailed" \
  --ratio "16:9" --resolution "2K" --background "opaque" \
  --output "/path/to/output.png"

python3 scripts/image_generation_tool.py image-to-url --image-path /path/to/local.png
```

## Gateway APIs

- `client.tools.generate_image(description, *, ratio, resolution, background,
  reference_image_urls)` → `resp.json()` = `{"media": {"url", "mime_type"}}`.
- `client.upload_storage(file, *, filename, content_type)` → `{"signed_url", ...}`;
  the `signed_url` is a public URL used for `reference_image_urls`.

## Catalog

Validate and publish from this directory after connecting to the internal network
and setting `MOONGATE_ACCESS_TOKEN`:

```bash
catalog validate
catalog publish
```
