---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

fix(kosong): make Gemini (google-genai/vertexai) tool-calling work

The Google GenAI provider built function declarations and content parts with
snake_case keys (`function_declarations`, `parameters_json_schema`,
`function_call`, `function_response`, `thought_signature`). The `@google/genai`
SDK expects camelCase, so it silently dropped those keys and sent empty tool
specs, causing Gemini to return `MALFORMED_FUNCTION_CALL`. Separately, tool-call
`thought_signature` extras captured from responses were dropped in the
agent-core tool-call event pipeline, so multi-turn Gemini 3.x tool use failed
with `missing thought_signature`.

Emit the camelCase keys the SDK expects and thread tool-call `extras` through the
event pipeline so thought signatures round-trip. Gemini tool-calling now works
for both `google-genai` and `vertexai`.
