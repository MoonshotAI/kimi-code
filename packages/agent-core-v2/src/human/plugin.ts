import type { AgentEmitted } from '#/agent/machine';
import type { SystemEntry, UserEntry } from '#/agent/turn';
import type { ToolDefinition } from '#/tool/tool';

export interface AgentPluginTarget {
  kind: 'agent';
  on(type: AgentEmitted['type'], handler: (event: AgentEmitted) => void): unknown;
  notify(entry: UserEntry): void;
  remind(entry: SystemEntry | UserEntry): void;
}

export type PluginTarget = AgentPluginTarget;

export interface Plugin {
  readonly name: string;
  tools?(): readonly ToolDefinition[];
  connect?(target: PluginTarget): void;
}

export function collectPluginTools(plugins: readonly Plugin[]): readonly ToolDefinition[] {
  return plugins.flatMap((plugin) => plugin.tools?.() ?? []);
}

export interface AgentPluginSource {
  on(type: AgentEmitted['type'], handler: (event: AgentEmitted) => void): unknown;
  send(
    event:
      | { type: 'input.notify'; entry: UserEntry }
      | { type: 'input.remind'; entry: SystemEntry | UserEntry },
  ): void;
}

export function connectPlugins(actor: AgentPluginSource, plugins: readonly Plugin[]): void {
  const target: AgentPluginTarget = {
    kind: 'agent',
    on: (type, handler) => {
      actor.on(type, handler);
    },
    notify: (entry) => {
      actor.send({ type: 'input.notify', entry });
    },
    remind: (entry) => {
      actor.send({ type: 'input.remind', entry });
    },
  };
  for (const plugin of plugins) {
    plugin.connect?.(target);
  }
}
