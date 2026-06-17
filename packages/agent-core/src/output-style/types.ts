export type OutputStyleSource = 'project' | 'user' | 'builtin';
export interface OutputStyle { readonly name: string; readonly description: string; readonly body: string; readonly source: OutputStyleSource; }
export interface ParsedOutputStyle { readonly name: string; readonly description: string; readonly body: string; }
