export interface WireEvent {
  readonly tool?: string;
  readonly settled?: boolean;
  readonly read?: string;
  readonly write?: string;
  readonly request?: string | number;
}

export interface FileEvidence {
  readonly timeline: readonly WireEvent[];
  readonly served: ReadonlySet<string | number | null>;
  readonly turnStart: number;
  readonly tool: string;
  readonly access: 'read' | 'write';
  readonly path: string;
}

export function editorServedFile({ timeline, served, turnStart, tool, access, path }: FileEvidence): boolean {
  const settled = timeline.findLastIndex((event) => event.tool === tool && event.settled === true);
  return timeline.slice(turnStart, settled + 1).some((event) => event.request !== undefined && served.has(event.request) && event[access] === path);
}
