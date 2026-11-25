import { IInstantiationService } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';
import { Service } from '@moonshot-ai/agent-core-v2/_base/di/service';
import { Emitter, type Event } from '@moonshot-ai/agent-core-v2/_base/event';
import type { ContextMessage } from '@moonshot-ai/agent-core-v2/agent/contextMemory/types';
import { IAgentLoopService } from '@moonshot-ai/agent-core-v2/agent/loop/loop';
import { SELECT_TOOLS_TOOL_NAME } from '@moonshot-ai/agent-core-v2/agent/toolSelect/toolSelect';
import { ISessionEventBus } from '@moonshot-ai/agent-core-v2/app/event/eventBus';
import { ISessionManager } from '@moonshot-ai/agent-core-v2/app/sessionManager/sessionManager';
import { IAgentLifecycleService } from '@moonshot-ai/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '@moonshot-ai/agent-core-v2/session/sessionContext/sessionContext';
import { SubagentSpawned } from '@moonshot-ai/agent-core-v2/session/subagent/mirrorAgentRun';

import { IHostBrowser, type ISessionHostBrowserService } from './browser-host-contract';

function toolResults(history: readonly ContextMessage[]): Map<string, string> {
  const results = new Map<string, string>();
  for (const message of history) {
    if (message.role !== 'tool' || message.toolCallId === undefined) continue;
    results.set(message.toolCallId, message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''));
  }
  return results;
}

export function historyUsedHostBrowser(
  history: readonly ContextMessage[],
  name: string,
  unavailableNotice: string,
): boolean {
  const mentionsBrowser = (text: string | null): boolean => text !== null && text.includes(name);
  if (history.some((message) => message.role === 'system' && (message.tools ?? []).some((tool) => tool.name === name))) {
    return true;
  }
  const results = toolResults(history);
  for (const message of history) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) {
      const result = results.get(call.id);
      if (call.name === name) {
        const refused = result !== undefined && (
          result.startsWith(`Tool "${name}" not found`)
          || result.startsWith(`Tool "${name}" is available but not loaded`)
          || result.includes(unavailableNotice)
        );
        if (!refused) return true;
      } else if (call.name === SELECT_TOOLS_TOOL_NAME && mentionsBrowser(call.arguments)) {
        if (result === undefined) return true;
        if (result.split('\n').some((line) => !line.startsWith('Unknown tool: ') && mentionsBrowser(line))) return true;
      }
    }
  }
  return false;
}

export class SessionHostBrowserService extends Service implements ISessionHostBrowserService {
  declare readonly _serviceBrand: undefined;

  private readonly sessionId: string;
  private readonly availabilityEmitter = this._register(new Emitter<void>());
  readonly onDidChangeAvailability: Event<void> = this.availabilityEmitter.event;

  constructor(
    @IHostBrowser readonly host: IHostBrowser,
    @IInstantiationService instantiation: IInstantiationService,
    @ISessionContext context: ISessionContext,
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionEventBus eventBus: ISessionEventBus,
  ) {
    super();
    this.sessionId = context.sessionId;
    const sessions = instantiation.invokeFunction((accessor) => accessor.get(ISessionManager));
    if (sessions.onDidCreateSession !== undefined) {
      this._register(sessions.onDidCreateSession((event) => {
        if (event.sessionId !== this.sessionId) return;
        this.keepIfUsed(host);
        this.availabilityEmitter.fire();
      }));
    }
    this._register(host.onDidChangeAvailability(() => {
      this.keepIfUsed(host);
      this.availabilityEmitter.fire();
    }));
    this._register(eventBus.subscribe(SubagentSpawned, (event) => {
      const agent = this.lifecycle.get(event.subagentId);
      if (agent !== undefined) host.describeSubagent(this.sessionId, event.subagentId, agent.generation, event.description);
    }));
    this._register({ dispose: () => host.closeSession(this.sessionId) });
  }

  available(): boolean {
    return this.host.allows(this.sessionId);
  }

  private keepIfUsed(host: IHostBrowser): void {
    if (host.allows(this.sessionId) || !this.usedBrowser(host)) return;
    host.keepSession(this.sessionId);
  }

  private usedBrowser(host: IHostBrowser): boolean {
    try {
      for (const agent of this.lifecycle.list()) {
        const history = this.lifecycle.handleOf(agent.agentId)?.accessor.get(IAgentLoopService).history() ?? [];
        if (historyUsedHostBrowser(history, host.tool.name, host.messages.unavailableNotice)) return true;
      }
    } catch {
      return false;
    }
    return false;
  }
}
