// Module-level runtime context, merged into every telemetry event as super
// properties (telemetry.ts). Kept dependency-free so connect.ts / tray.ts can
// write it without pulling the telemetry wiring module (agent-core-v2) into
// their load-time graph.

export type ServerMode = 'embedded' | 'external';

let serverMode: ServerMode | undefined;
let locale: string | undefined;

export function setServerMode(mode: ServerMode | undefined): void {
  serverMode = mode;
}

export function getServerMode(): ServerMode | undefined {
  return serverMode;
}

export function setRuntimeLocale(next: string | undefined): void {
  locale = next;
}

export function getRuntimeLocale(): string | undefined {
  return locale;
}
