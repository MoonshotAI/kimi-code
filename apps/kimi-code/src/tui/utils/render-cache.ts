let enabled = process.env['KIMI_TUI_NO_RENDER_CACHE'] !== '1';

export function isRenderCacheEnabled(): boolean {
  return enabled;
}

export function setRenderCacheEnabled(value: boolean): void {
  enabled = value;
}
