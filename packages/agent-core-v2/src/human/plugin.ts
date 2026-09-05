import type { SystemMessage, UserMessage } from '#/llm/message';
import type { AgentEmitted } from '#/agent/machine';
import type { ToolDefinition } from '#/tool/tool';

export interface AgentPluginTarget {
  kind: 'agent';
  on(type: AgentEmitted['type'], handler: (event: AgentEmitted) => void): unknown;
  notify(message: UserMessage): void;
  remind(key: string, message: UserMessage | SystemMessage): void;
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
      | { type: 'input.notify'; message: UserMessage }
      | { type: 'input.reminder'; key: string; message: UserMessage | SystemMessage },
  ): void;
}

export function connectPlugins(actor: AgentPluginSource, plugins: readonly Plugin[]): void {
  const target: AgentPluginTarget = {
    kind: 'agent',
    on: (type, handler) => {
      actor.on(type, handler);
    },
    notify: (message) => {
      actor.send({ type: 'input.notify', message });
    },
    remind: (key, message) => {
      actor.send({ type: 'input.reminder', key, message });
    },
  };
  for (const plugin of plugins) {
    plugin.connect?.(target);
  }
}
