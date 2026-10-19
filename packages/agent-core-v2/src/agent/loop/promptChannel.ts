import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IEventService } from '#/app/event/event';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { promptMetadataTextFromContentParts } from '#/agent/prompt/promptMetadataText';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { applyPromptMetadataUpdate } from '#/session/sessionMetadata/promptMetadata';

import {
  IAgentLoopService,
  type PromptLaunchResult,
  type PromptPayload,
  type SteerPayload,
} from './loop';

export interface IAgentPromptChannel {
  readonly _serviceBrand: undefined;
  submit(payload: PromptPayload): Promise<PromptLaunchResult | undefined>;
  submitSteer(payload: SteerPayload): Promise<PromptLaunchResult | undefined>;
}

export const IAgentPromptChannel = createDecorator<IAgentPromptChannel>('agentPromptService');

export class AgentPromptChannel implements IAgentPromptChannel {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {}

  async submit(payload: PromptPayload): Promise<PromptLaunchResult | undefined> {
    await this.updateMetadata(promptMetadataTextFromContentParts(payload.input));
    const status = this.loop.snapshot();
    const { id } = this.loop.submit({
      message: { role: 'user', content: [...payload.input] },
      meta: { promptId: payload.promptId, origin: { kind: 'user' }, tracked: true },
    });
    if (status.state === 'running' || status.paused || status.queue.length > 0) return undefined;
    return launchResult(this.loop, id);
  }

  async submitSteer(payload: SteerPayload): Promise<PromptLaunchResult | undefined> {
    this.telemetry.track2('input_steer', { parts: payload.input.length });
    await this.updateMetadata(promptMetadataTextFromContentParts(payload.input));
    const status = this.loop.snapshot();
    const { id } = this.loop.submit(
      {
        message: { role: 'user', content: [...payload.input] },
        meta: { origin: { kind: 'user' }, tracked: true },
      },
      { steerIfActive: true },
    );
    if (status.state === 'running' && status.activePromptId === undefined) return undefined;
    return launchResult(this.loop, id);
  }

  private async updateMetadata(text: string | undefined): Promise<void> {
    if (this.scopeContext.agentId !== MAIN_AGENT_ID) return;
    await applyPromptMetadataUpdate(
      {
        metadata: this.metadata,
        eventService: this.eventService,
        sessionId: this.sessionContext.sessionId,
      },
      text,
    );
  }
}

async function launchResult(
  loop: IAgentLoopService,
  id: string,
): Promise<PromptLaunchResult | undefined> {
  const turn = await loop.promptHandle(id)?.launched;
  if (turn === undefined) return undefined;
  await turn.ready.catch(() => undefined);
  return turn.id === undefined ? undefined : { turn_id: turn.id };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPromptChannel,
  AgentPromptChannel,
  ScopeActivation.OnDemand,
  'prompt',
);
