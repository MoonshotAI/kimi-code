const COMPUTER_USE_TOOL_NAME = /^mcp__(?:kimi-cu|plugin-kimi-cu_mac|plugin-kimi-cu-win_win)__(.+)$/;

export function computerUseToolName(name: string): string | undefined {
  return COMPUTER_USE_TOOL_NAME.exec(name)?.[1];
}
