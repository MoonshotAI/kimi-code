---
"@moonshot-ai/kimi-code": patch
---

Fix prompts blocked by a UserPromptSubmit hook keeping unsupported or malformed images in the session history unfiltered; blocked prompts now go through the same image format check as prompts that reach the model, so a rejected image becomes a text notice instead of failing later requests.
