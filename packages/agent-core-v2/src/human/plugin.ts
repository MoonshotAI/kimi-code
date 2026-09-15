import type { SystemMessage, UserMessage } from '#/llm/message';
import type { AgentEmitted } from '#/agent/machine';
import { createSystemEntry, createUserEntry, type SystemEntry, type UserEntry } from '#/agent/turn';
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
      | { type: 'input.notify'; entry: UserEntry }
      | { type: 'input.remind'; key: string; entry: SystemEntry | UserEntry },
  ): void;
}

export function connectPlugins(actor: AgentPluginSource, plugins: readonly Plugin[]): void {
  const target: AgentPluginTarget = {
    kind: 'agent',
    on: (type, handler) => {
      actor.on(type, handler);
    },
    notify: (message) => {
      actor.send({ type: 'input.notify', entry: { message } });
    },
    remind: (key, message) => {
      actor.send({
        type: 'input.remind',
        key,
        entry: message.role === 'system' ? createSystemEntry(message) : createUserEntry(message),
      });
    },
  };
  for (const plugin of plugins) {
    plugin.connect?.(target);
  }
}
