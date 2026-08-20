export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  deferred?: true;
}
