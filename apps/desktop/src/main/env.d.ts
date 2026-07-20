// Ambient declarations for the Electron main process bundle (tsdown).

declare global {
  // Injected by tsdown `define` (see tsdown.config.ts): the kimi-code core
  // (CLI) version of the bundled submodule sources. Passed to kap-server as
  // its `version` opt so GET /api/v1/meta reports the engine version instead
  // of the desktop app's own package.json version (the bundled default).
  const __KIMI_CORE_VERSION__: string;
}

export {};
