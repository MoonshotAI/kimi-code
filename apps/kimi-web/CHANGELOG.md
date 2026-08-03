# @moonshot-ai/kimi-web

## 未发布

### Patch Changes（二开 fork）

- Provider 模型自动发现：`refreshAllProviders` 走 v1 RPC 刷新所有可刷新 provider 的远程模型元数据；新增 DeepSeek / Ollama 等 OpenAI 兼容 provider 预设；切换模型弹窗展示自动发现的模型；修复刷新页面后 provider 与模型丢失、"暂无提供商"显示问题。
- 嵌套模态框层级修复：新增 `--z-modal-top` z-index 变量与 `Dialog` 的 `layer` 属性，`ConfirmDialog` 设置 `layer="top"`，删除确认弹窗不再被设置弹窗覆盖。
- `openModelPicker` 触发 `refreshAllProviders` 后再展示弹窗，确保列表为最新。

## 0.1.2

### Patch Changes

- [#1085](https://github.com/MoonshotAI/kimi-code/pull/1085) [`f1fad72`](https://github.com/MoonshotAI/kimi-code/commit/f1fad7222ccd3f66c1cae6c5b9c009230227cd2f) - Fix stuttery streaming in the web chat by coalescing rapid token updates into a single render per frame.
