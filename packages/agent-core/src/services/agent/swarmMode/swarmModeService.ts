import SWARM_MODE_ENTER_REMINDER from '../../../agent/swarm/enter-reminder.md?raw';
import SWARM_MODE_EXIT_REMINDER from '../../../agent/swarm/exit-reminder.md?raw';
import {
  Disposable,
  registerSingleton,
  SyncDescriptor,
} from '../../../di';
import { AgentSwarmTool } from '../../../tools/builtin/collaboration/agent-swarm';

import { IContextMemory } from '../contextMemory/contextMemory';
import { IEventBus } from '../eventBus/eventBus';
import { ISubagentHost } from '../subagentHost/subagentHost';
import { IToolRegistry } from '../toolRegistry/toolRegistry';
import { ITurnRunner } from '../turnRunner/turnRunner';
import type { ContextMessage } from '../types';
import { IWireRecord } from '../wireRecord/wireRecord';
import {
  ISwarmMode,
  type SwarmModeTrigger,
} from './swarmMode';

export class SwarmModeService extends Disposable implements ISwarmMode {
  declare readonly _serviceBrand: undefined;

  private _active: SwarmModeTrigger | null = null;

  constructor(
    @IContextMemory private readonly context: IContextMemory,
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IEventBus private readonly events: IEventBus,
    @ITurnRunner turnRunner?: ITurnRunner,
    @IToolRegistry toolRegistry?: IToolRegistry,
    @ISubagentHost subagentHost?: ISubagentHost,
  ) {
    super();
    this._register(
      wireRecord.register('swarm_mode.enter', (record) => {
        this.restoreEnter(record.trigger);
      }),
    );
    this._register(
      wireRecord.register('swarm_mode.exit', () => {
        this.applyExit(false);
      }),
    );
    if (turnRunner !== undefined) {
      this._register(
        turnRunner.hooks.onEnded.register('swarm-mode-auto-exit', async (_ctx, next) => {
          await next();
          if (this.shouldAutoExit) {
            this.exit();
          }
        }),
      );
    }
    this._register(
      this.requireToolRegistry(toolRegistry).register(
        new AgentSwarmTool(this.requireSubagentHost(subagentHost), this),
      ),
    );
  }

  enter(trigger: SwarmModeTrigger): void {
    if (this._active !== null) return;
    this.wireRecord.append({ type: 'swarm_mode.enter', trigger });
    this.applyEnter(trigger, true);
  }

  exit(): void {
    if (this._active === null) return;
    this.wireRecord.append({ type: 'swarm_mode.exit' });
    this.applyExit(true);
  }

  restoreEnter(trigger: SwarmModeTrigger): void {
    this.applyEnter(trigger, false);
  }

  data(): boolean {
    return this.isActive;
  }

  get active(): SwarmModeTrigger | null {
    return this._active;
  }

  get isActive(): boolean {
    return this._active !== null;
  }

  get shouldAutoExit(): boolean {
    return this._active === 'task' || this._active === 'tool';
  }

  private applyEnter(trigger: SwarmModeTrigger, injectReminder: boolean): void {
    if (this._active !== null) return;
    this._active = trigger;
    if (injectReminder && trigger !== 'tool') {
      this.appendSystemReminder(SWARM_MODE_ENTER_REMINDER, 'swarm_mode');
    }
    this.emitChanged();
  }

  private applyExit(injectExitReminder: boolean): void {
    if (this._active === null) return;
    const trigger = this._active;
    this._active = null;
    if (injectExitReminder && trigger !== 'tool' && !this.removeLastSwarmReminder()) {
      this.appendSystemReminder(SWARM_MODE_EXIT_REMINDER, 'swarm_mode_exit');
    }
    this.emitChanged();
  }

  private emitChanged(): void {
    this.events.emit({ type: 'swarm_mode.changed', active: this._active });
    this.events.emit({ type: 'agent.status.updated', swarmMode: this.isActive });
  }

  private requireToolRegistry(toolRegistry: IToolRegistry | undefined): IToolRegistry {
    if (toolRegistry !== undefined) return toolRegistry;
    throw new Error('AgentSwarm requires the agent tool registry service.');
  }

  private requireSubagentHost(subagentHost: ISubagentHost | undefined): ISubagentHost {
    if (subagentHost !== undefined) return subagentHost;
    throw new Error('AgentSwarm requires the agent subagent host service.');
  }

  private appendSystemReminder(content: string, variant: string): void {
    const message: ContextMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<system-reminder>\n${content.trim()}\n</system-reminder>`,
        },
      ],
      toolCalls: [],
      origin: {
        kind: 'injection',
        variant,
      },
    };
    this.context.spliceHistory(this.context.getHistory().length, 0, message);
  }

  private removeLastSwarmReminder(): boolean {
    const history = this.context.getHistory();
    for (let index = history.length - 1; index >= 0; index--) {
      const message = history[index];
      if (message?.origin?.kind !== 'injection') continue;
      if (message.origin.variant !== 'swarm_mode') continue;
      this.context.spliceHistory(index, 1);
      return true;
    }
    return false;
  }
}

registerSingleton(
  ISwarmMode,
  new SyncDescriptor(SwarmModeService, [], true),
);
