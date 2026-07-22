---
name: image_generation
description: |-
  Create an image based on a text description using AI image generation.

  ### Features:
  - Generate high-quality images from text prompts
  - Support conditional opaque image size combinations: 1K supports 1:1, 3:2, 2:3; 2K supports 1:1, 16:9; 4K supports 16:9, 9:16.
  - Support multiple resolutions: 1K, 2K, 4K. Default is 1K.
  - If the background is transparent, only supports 1:1, 3:2, 2:3 ratios and 1K resolution.
  - Support background color: opaque (default) or transparent
  - Support JPG, JPEG, PNG format output with high resolution (only support png for transparent)

  ### Usage Guidelines:
  - Provide detailed, descriptive prompts for better results
  - Include specific details about style, composition, colors, and mood
  - Use clear, descriptive language for best image quality
  - Specify output file path with .jpg, .jpeg, .png extension (only support png for transparent)

  ### Best Practices:
  - Be specific about visual elements (lighting, perspective, style)
  - Include artistic style references when desired
  - Describe composition and framing details
  - Mention color schemes and atmosphere
---

# Image Generation

Use this skill to create an image from a text description with AI image
generation, then save it locally and display it to the user.

## Setup

Before the first use, ensure the agent-gw Python SDK (version 0.2.6 or newer) is installed. This checks the current environment and installs or upgrades it only when needed:

```bash
python3 "${KIMI_SKILL_DIR}/../../scripts/image_generation_tool.py" ensure-deps
```

The SDK needs an API key from `api_key=...`, `KIMI_API_KEY`, or
`~/.kimi/agent-gw.json`.

## Parameters

- `description` (required): detailed text description of the image to generate.
- `ratio`: one of `1:1, 3:2, 2:3, 16:9, 9:16`. Default `1:1`.
- `resolution`: one of `1K, 2K, 4K`. Default `1K`.
  Opaque background supports only these combinations:
  `1K`: `1:1` (`1024x1024`), `3:2` (`1536x1024`), `2:3` (`1024x1536`);
  `2K`: `1:1` (`2048x2048`), `16:9` (`2048x1152`);
  `4K`: `16:9` (`3840x2160`), `9:16` (`2160x3840`).
  Transparent background only supports `1K` with `1:1, 3:2, 2:3`.
- `background`: `opaque` (default) or `transparent`.
- `reference_image`: public URL(s) that guide the generation. Repeat
  `--reference-image` for multiple. The gateway only accepts public URLs, so a
  local image must be converted with `image-to-url` first (see "Reference
  images" below); passing a local path to `generate` is rejected.
- `output` (required): local output path ending in `.jpg`, `.jpeg`, or `.png`.
  Transparent background must use `.png`.

## Workflow

1. Build a detailed, descriptive `description` from the user's request: include
   subject, style, composition, lighting, colors, and mood.
2. Choose `ratio`, `resolution`, and `background`. Enforce the supported
   combinations. For opaque images: `1K` allows `1:1 / 3:2 / 2:3`; `2K`
   allows `1:1 / 16:9`; `4K` allows `16:9 / 9:16`. Transparent only allows
   `1:1 / 3:2 / 2:3` ratios, `1K` resolution, and PNG output.
3. Pick an `output` file path with a matching extension.
4. If the user supplies reference images, they must be public URLs. For any
   local image (a file on the execution environment, whether that is a sandbox
   or the client's local machine), first run the `image-to-url` command to
   upload it and get a public URL, then pass that URL with `--reference-image`.
   The gateway only accepts public reference URLs; passing a local path to
   `generate` is rejected.
5. Run the `generate` command (see "Script"). It calls `generate_image` on the
   gateway, reads `media.url` / `media.mime_type` from the response, and
   downloads the image to your `output` path with `curl` (the extension is
   corrected to match `mime_type`).
6. If the call fails, explain the failure reason from the printed error. Do not
   invent an image or a local path.
7. On success, the script prints the saved file path. Then **display the image
   to the user by calling the `readFile` tool on that path**. Reading the image
   to show it is the model's job, not this plugin's work.

## Reference images

The plugin runs in an execution environment that may be a sandbox or the
client's local machine. Either way, the gateway's `reference_image_urls` must be
public URLs, so any local reference image has to be converted first. This is an
explicit, separate step — `generate` does **not** accept local paths.

Convert each local image to a public URL with `image-to-url` (it uploads the
file via the agent-gw `upload_storage` API and returns the public `signed_url`),
then pass the printed public URL to `generate` with `--reference-image`:

```bash
python3 "${KIMI_SKILL_DIR}/../../scripts/image_generation_tool.py" image-to-url --image-path /path/to/local.png
```

## Script

Use the bundled script from the plugin directory.

Generate an image:

```bash
python3 "${KIMI_SKILL_DIR}/../../scripts/image_generation_tool.py" generate \
  --description "A serene mountain lake at sunrise, soft golden light, mirror reflection, ultra detailed" \
  --ratio "16:9" \
  --resolution "2K" \
  --background "opaque" \
  --output "/path/to/output.png"
```

Convert a local reference image to a public URL first, then pass that URL:

```bash
# Step 1: upload the local image, capture the printed public URL
python3 "${KIMI_SKILL_DIR}/../../scripts/image_generation_tool.py" image-to-url --image-path /path/to/local_ref.png

# Step 2: pass public URLs (only) to generate
python3 "${KIMI_SKILL_DIR}/../../scripts/image_generation_tool.py" generate \
  --description "Same character in a snowy forest, cinematic" \
  --ratio "3:2" \
  --reference-image "https://example.com/ref1.jpg" \
  --reference-image "https://<public-url-from-step-1>" \
  --output "/path/to/output.jpg"
```

The script:

- `generate` accepts only public `--reference-image` URLs and sends them as
  `reference_image_urls`; a local path is rejected with a hint to use
  `image-to-url`
- `image-to-url` uploads a local image via the agent-gw `upload_storage` API and
  prints the resulting public `signed_url`
- sends `{"description", "ratio", "resolution", "background",
  "reference_image_urls"}` to the gateway `generate_image` API
- reads the generated `media.url` and `media.mime_type` from the response
- downloads the image to the `--output` path with `curl`, naming the file by
  `mime_type` (png/jpg)
- prints the saved path and a reminder to display it with `readFile`

`generate_image` response shape (`resp.json()`):

```python
{
    "media": {
        "url": str,        # public URL of the generated image
        "mime_type": str,  # e.g. "image/png" or "image/jpeg"
    }
}
```

> This skill uses the agent-gw Python SDK: `client.tools.generate_image(...)`
> for generation and `client.upload_storage(...)` (which returns a public
> `signed_url`) to turn a local reference image into a public URL.
