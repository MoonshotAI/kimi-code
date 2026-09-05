---
'@moonshot-ai/kimi-code': minor
---

Add a dedicated `[visual_model]` configuration section that lets users pin a vision-capable model for image / screenshot / video inspection tasks, mirroring the existing experimental `[secondary_model]` slot.

When the `visual-model` experiment is enabled (`KIMI_CODE_EXPERIMENTAL_VISUAL_MODEL=1`) and `[visual_model]` is configured, the `ReadMediaFile` tool registers against the visual model's capabilities and requester when the caller's main model is text-only — so the LLM keeps access to image inspection instead of silently losing the tool. When unset, behavior is unchanged. Adds parallel `resolveVisualModel` / `resolveVisualBinding` / `buildVisualModelDescriptions` resolvers and a `visual-model` experiment flag, all gated by the experiment and covered by vitest tests.
