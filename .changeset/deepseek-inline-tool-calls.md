---
"@moonshot-ai/kosong": patch
---

Parse DeepSeek-format inline tool calls when an OpenAI-compatible backend leaves them unstructured.

DeepSeek-architecture models (deepseek-v3/r1 and derivatives such as cogito) emit tool calls as special tokens rather than OpenAI `tool_calls`. DeepSeek's own API structures these server-side, but many compatible deployments — self-hosted vLLM/SGLang/llama.cpp, ollama, and some proxies — leak the raw `<|tool▁calls▁begin|>…` tokens into the assistant content, leaving the agent with nothing to dispatch and the turn dead-ending. The OpenAI chat-completions provider now detects that case, parses the tokens into structured tool calls, and strips them from the visible text — but only when the backend returned no structured call, so it stays a no-op for providers that already do the right thing.
