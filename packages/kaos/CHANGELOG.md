# @moonshot-ai/kaos

## 0.1.4

### Patch Changes

- [#529](https://github.com/MoonshotAI/kimi-code/pull/529) [`3b62b12`](https://github.com/MoonshotAI/kimi-code/commit/3b62b123e68cc4543bfa8fa376c7e8a24fee0afb) - Detect Git Bash installed through Scoop and other Git shims on Windows.

## 0.1.3

### Patch Changes

- [#282](https://github.com/MoonshotAI/kimi-code/pull/282) [`a580cd3`](https://github.com/MoonshotAI/kimi-code/commit/a580cd3a98664e18642e0e856aeaa9b71ba93516) - Fix glob pattern backslash escaping and include match count in truncation messages.

## 0.1.2

### Patch Changes

- [#84](https://github.com/MoonshotAI/kimi-code/pull/84) [`e5717b7`](https://github.com/MoonshotAI/kimi-code/commit/e5717b7261599f4b4379aa34eb0b5fdf2dd93898) - Unify path normalization by replacing ad-hoc `toForwardSlashes` helpers with `pathe`. Remove unnecessary `node:path/win32` branching in path-access policies and tools, and inline unused `joinPath` wrappers. Platform-specific path separators are now handled consistently through a single module.
