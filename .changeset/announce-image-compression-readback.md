---
"@moonshot-ai/kimi-code": minor
---

Never compress images silently. Every image ingestion point (ReadMediaFile, MCP tool results, clipboard paste, REST upload/inline base64, ACP) now places a caption next to a compressed image stating the original vs. delivered dimensions, byte size, and format, and preserves the original bytes for readback: uploads point at the stored file, and in-memory images are saved into the session's `media-originals` directory (size-capped, removed with the session; a shared temp-dir cache is the fallback when no session is known). ReadMediaFile gains a `region` parameter (crop in original-image pixel coordinates, delivered at full fidelity) and a `full_resolution` flag (skip downscaling, with an explicit error when the file exceeds the per-image byte limit), so the model can zoom into fine detail instead of degrading silently.
