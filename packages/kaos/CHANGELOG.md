# @moonshot-ai/kaos

## 0.1.2

### Patch Changes

- [#84](https://github.com/MoonshotAI/kimi-code/pull/84) [`e5717b7`](https://github.com/MoonshotAI/kimi-code/commit/e5717b7261599f4b4379aa34eb0b5fdf2dd93898) - Unify path normalization by replacing ad-hoc `toForwardSlashes` helpers with `pathe`. Remove unnecessary `node:path/win32` branching in path-access policies and tools, and inline unused `joinPath` wrappers. Platform-specific path separators are now handled consistently through a single module.
