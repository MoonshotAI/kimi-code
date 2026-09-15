import type { SystemMessage, UserMessage } from '#/llm/message';
import type { AgentEmitted } from '#/agent/machine';
import { createSystemEntry, createUserEntry, type SystemEntry, type UserEntry } from '#/agent/turn';
import { currentUnit, hasCurrentUnit, pushCleanup } from '#/kernel/index';
import type { ToolDefinition } from '#/tool/tool';
import type { Subscription } from '#/xstate2';

export interface AgentPluginTarget {
  kind: 'agent';
  on(type: AgentEmitted['type'], handler: (event: AgentEmitted) => void): Subscription;
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
  on(type: AgentEmitted['type'], handler: (event: AgentEmitted) => void): Subscription;
  send(
    event:
      | { type: 'input.notify'; entry: UserEntry }
      | { type: 'input.remind'; key: string; entry: SystemEntry | UserEntry },
  ): void;
}

export function createAgentPluginTarget(actor: AgentPluginSource): AgentPluginTarget {
  return {
    kind: 'agent',
    on: (type, handler) => {
      const subscription = actor.on(type, handler);
      if (hasCurrentUnit()) {
        pushCleanup(currentUnit(), () => subscription.unsubscribe());
      }
      return subscription;
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
}

export function connectPlugins(actor: AgentPluginSource, plugins: readonly Plugin[]): void {
  const target = createAgentPluginTarget(actor);
  for (const plugin of plugins) {
    plugin.connect?.(target);
  }
}
