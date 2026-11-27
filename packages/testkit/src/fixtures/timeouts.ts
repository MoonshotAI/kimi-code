const PLATFORM_FACTOR = process.platform === 'win32' ? 2 : 1;

export const TIMEOUTS = {
  wait: 10_000 * PLATFORM_FACTOR,
  request: 10_000 * PLATFORM_FACTOR,
  frame: 10_000 * PLATFORM_FACTOR,
  server: 30_000 * PLATFORM_FACTOR,
} as const;
