---
"@moonshot-ai/kimi-code": patch
---

Compress oversized WebP images instead of passing them through uncompressed: still WebP now decodes via a bundled wasm codec and re-encodes on the same lossless-first ladder as PNG (keeping alpha), the read byte budget and edge cap apply, and `region` crops work on WebP files; animated WebP still passes through whole to preserve the animation.
