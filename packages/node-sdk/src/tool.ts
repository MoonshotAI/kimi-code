export type ToolSource = 'builtin' | 'user' | 'mcp';

export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  readonly active: boolean;
  readonly source: ToolSource;
}
