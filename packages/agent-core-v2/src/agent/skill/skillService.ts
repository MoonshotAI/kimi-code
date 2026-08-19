import { randomUUID } from 'node:crypto';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import type { ContentPart } from '#/kosong/contract/message';

import type {
  BundledSkillActivation,
  ContextMessage,
  SkillActivationOrigin,
} from '#/agent/contextMemory/types';
import { promptMetadataTextFromSkill, renderUserSlashSkillPrompt } from './prompt';
import { promptMetadataTextFromContentParts } from '#/agent/prompt/promptMetadataText';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { Service } from '#/_base/di/service';
import { ErrorCodes, Error2 } from '#/errors';
import { isUserActivatableSkillType, type SkillDefinition } from '#/app/skillCatalog/types';
import { IAgentPromptService, reservePrompt, type PromptHandle, type PromptLaunchResult } from '#/agent/prompt/prompt';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentLoopService, type Turn } from '#/agent/loop/loop';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  IAgentSkillService,
  type PromptSkillActivation,
  type PromptWithSkillsInput,
  type PromptWithSkillsResult,
  type SkillActivationInput,
} from './skill';
import { SkillActivate, skillKey } from './skillOps';
import { ISkillActivationDataService } from './skillActivationData';
import { IFlagService } from '#/app/flag/flag';
import { IConfigService } from '#/app/config/config';
import { FLOW_FLAG_ID, IAgentFlowService } from '#/features/flow/flow';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { IEventService } from '#/app/event/event';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { applyPromptMetadataUpdate } from '#/session/sessionMetadata/promptMetadata';

export class AgentSkillService extends Service implements IAgentSkillService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService agentState: IAgentStateService,
    @ISkillActivationDataService private readonly activationData: ISkillActivationDataService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentFlowService private readonly flow: IAgentFlowService,
    @IConfigService configService: IConfigService,
  ) {
    super();
    agentState.contributeState(skillKey);
    let flowFlagWas = this.flags.enabled(FLOW_FLAG_ID);
    this._register(
      configService.onDidChangeConfiguration(() => {
        const flagNow = this.flags.enabled(FLOW_FLAG_ID);
        if (flagNow === flowFlagWas) return;
        flowFlagWas = flagNow;
        if (flagNow) return;
        const queued = Array.from(this.queuedFlowPrompts);
        for (const promptId of queued) {
          try {
            this.prompt.abort(promptId);
          } catch {
            this.queuedFlowPrompts.delete(promptId);
          }
        }
      }),
    );
  }

  private readonly queuedFlowPrompts = new Set<string>();

  private trackQueuedFlowPrompt(handle: PromptHandle): void {
    this.queuedFlowPrompts.add(handle.id);
    void handle.completion.then(() => {
      this.queuedFlowPrompts.delete(handle.id);
    });
  }

  async activate(input: SkillActivationInput): Promise<PromptLaunchResult> {
    await this.skillCatalog.ready;
    const skill = this.skillCatalog.catalog.getSkill(input.name);
    if (skill === undefined) {
      throw new Error2(ErrorCodes.SKILL_NOT_FOUND, `Skill "${input.name}" was not found`);
    }
    if (!isUserActivatableSkillType(skill.metadata.type)) {
      throw new Error2(
        ErrorCodes.SKILL_TYPE_UNSUPPORTED,
        `Skill "${skill.name}" cannot be activated by the user`,
      );
    }
    if (skill.metadata.type === 'flow' && this.scopeContext.agentId !== MAIN_AGENT_ID) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        `Flow skill "${skill.name}" can only be activated on the main agent`,
      );
    }
    this.rejectWhileFlowRunActive(skill.metadata.type);

    const skillArgs = input.args ?? '';
    const skillContent = this.renderSkillPrompt(skill, skillArgs);
    const content: ContentPart[] = [
      {
        type: 'text',
        text: renderUserSlashSkillPrompt({
          skillName: skill.name,
          skillArgs,
          skillContent,
          skillSource: skill.source,
          skillDir: skill.dir,
        }),
      },
      ...(input.content ?? []),
    ];

    const origin: SkillActivationOrigin = {
      kind: 'skill_activation',
      activationId: randomUUID(),
      skillName: skill.name,
      trigger: 'user-slash',
      skillType: skill.metadata.type,
      skillPath: skill.path,
      skillSource: skill.source,
      skillArgs: input.args,
    };
    this.activationData.put(origin.activationId, skill.data);
    let turn: Turn | undefined;
    try {
      turn = await this.recordActivation(origin, content);
    } catch (error) {
      this.activationData.take(origin.activationId);
      this.flow.discardPendingActivation(origin.activationId);
      throw error;
    }
    if (turn === undefined) {
      this.activationData.take(origin.activationId);
      this.flow.discardPendingActivation(origin.activationId);
      throw new Error2(
        ErrorCodes.TURN_AGENT_BUSY,
        'Cannot activate skill while another turn is active',
      );
    }
    if (this.scopeContext.agentId === MAIN_AGENT_ID) {
      await applyPromptMetadataUpdate(
        {
          metadata: this.metadata,
          eventService: this.eventService,
          sessionId: this.sessionContext.sessionId,
        },
        promptMetadataTextFromSkill(input),
      );
    }
    return { turn_id: turn.id };
  }

  async promptWithSkills(input: PromptWithSkillsInput): Promise<PromptWithSkillsResult> {
    if (input.input.length === 0) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'promptWithSkills requires a non-empty prompt');
    }
    if (input.skills.length === 0) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        'promptWithSkills requires at least one skill',
      );
    }
    await this.skillCatalog.ready;
    const prepared: {
      origin: SkillActivationOrigin;
      part: ContentPart;
      entry: BundledSkillActivation;
    }[] = [];
    try {
      for (const skill of input.skills) prepared.push(this.prepareBundled(skill));
    } catch (error) {
      for (const activation of prepared) {
        this.activationData.take(activation.origin.activationId);
      }
      throw error;
    }
    const flowActivations = prepared.filter((activation) => activation.origin.skillType === 'flow');
    const discardPrepared = (): void => {
      for (const activation of prepared) {
        this.activationData.take(activation.origin.activationId);
      }
    };
    if (flowActivations.length > 1) {
      discardPrepared();
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        'A prompt can bundle at most one flow skill: each flow run needs its own prompt.',
      );
    }
    if (flowActivations.length > 0 && this.scopeContext.agentId !== MAIN_AGENT_ID) {
      discardPrepared();
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        'Flow skills can only be activated on the main agent',
      );
    }
    if (this.scopeContext.agentId === MAIN_AGENT_ID) {
      await applyPromptMetadataUpdate(
        {
          metadata: this.metadata,
          eventService: this.eventService,
          sessionId: this.sessionContext.sessionId,
        },
        promptMetadataTextFromContentParts(input.input),
      );
    }
    try {
      if (flowActivations.length > 0) this.rejectWhileFlowRunActive('flow');
    } catch (error) {
      discardPrepared();
      throw error;
    }
    for (const activation of prepared) {
      void this.recordActivation(activation.origin);
    }
    const reservation = reservePrompt(this.prompt);
    try {
      const handle = await reservation.submit({
        role: 'user',
        content: [...prepared.map((activation) => activation.part), ...input.input],
        toolCalls: [],
        origin: {
          kind: 'user',
          skillActivations: prepared.map((activation) => activation.entry),
        },
      });
      if (flowActivations.length > 0) {
        this.trackQueuedFlowPrompt(handle);
        const flowIds = flowActivations.map((activation) => activation.origin.activationId);
        void handle.completion.then((completion) => {
          if (
            completion.state !== 'cancelled' &&
            completion.state !== 'failed' &&
            completion.state !== 'blocked'
          ) {
            return;
          }
          for (const id of flowIds) {
            this.flow.discardPendingActivation(id);
            this.activationData.take(id);
          }
        });
      }
      if (handle.state === 'pending') {
        return { prompt_id: handle.id, created_at: handle.createdAt, state: 'queued' };
      }
      const turn = await handle.launched;
      if (turn === undefined && handle.state !== 'blocked') {
        throw new Error2(ErrorCodes.INTERNAL, 'promptWithSkills failed to launch a turn');
      }
      return {
        turn_id: turn?.id,
        prompt_id: handle.id,
        created_at: handle.createdAt,
        state: handle.state === 'blocked' ? 'blocked' : 'running',
      };
    } finally {
      reservation.dispose();
    }
  }

  recordModelToolActivation(origin: SkillActivationOrigin): void {
    void this.recordActivation(origin);
  }

  private prepareBundled(input: PromptSkillActivation): {
    readonly origin: SkillActivationOrigin;
    readonly part: ContentPart;
    readonly entry: BundledSkillActivation;
  } {
    const skill = this.skillCatalog.catalog.getSkill(input.name);
    if (skill === undefined) {
      throw new Error2(ErrorCodes.SKILL_NOT_FOUND, `Skill "${input.name}" was not found`);
    }
    if (!isUserActivatableSkillType(skill.metadata.type)) {
      throw new Error2(
        ErrorCodes.SKILL_TYPE_UNSUPPORTED,
        `Skill "${skill.name}" cannot be activated by the user`,
      );
    }

    const skillArgs = input.args ?? '';
    const skillContent = this.renderSkillPrompt(skill, skillArgs);
    const origin: SkillActivationOrigin = {
      kind: 'skill_activation',
      activationId: randomUUID(),
      skillName: skill.name,
      trigger: 'user-slash',
      skillType: skill.metadata.type,
      skillPath: skill.path,
      skillSource: skill.source,
      skillArgs: input.args,
    };
    this.activationData.put(origin.activationId, skill.data);
    return {
      origin,
      part: {
        type: 'text',
        text: renderUserSlashSkillPrompt({
          skillName: skill.name,
          skillArgs,
          skillContent,
          skillSource: skill.source,
          skillDir: skill.dir,
        }),
      },
      entry: {
        activationId: origin.activationId,
        skillName: origin.skillName,
        skillArgs: origin.skillArgs,
        skillType: origin.skillType,
        skillPath: origin.skillPath,
        skillSource: origin.skillSource,
      },
    };
  }

  private rejectWhileFlowRunActive(skillType: string | undefined): void {
    if (skillType !== 'flow') return;
    if (!this.flags.enabled(FLOW_FLAG_ID)) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        'The flow feature is disabled ([experimental].flow); enable it before activating a flow skill.',
      );
    }
    if (!this.flow.run().active && !this.flow.hasPendingActivation()) return;
    throw new Error2(
      ErrorCodes.REQUEST_INVALID,
      'A flow run is already active or queued in this session. Finish or abort it (FlowAbort) before starting another flow.',
    );
  }

  private async recordActivation(
    origin: SkillActivationOrigin,
    input?: readonly ContentPart[],
  ): Promise<Turn | undefined> {
    await this.dispatcher.dispatch(new SkillActivate({ origin }));
    this.publishActivation(origin);

    if (input === undefined) return undefined;
    const message: ContextMessage = {
      role: 'user',
      content: [...input],
      toolCalls: [],
      origin,
    };
    if (this.loop.status().state === 'running') {
      return this.prompt.inject(message);
    }
    const handle = await this.prompt.enqueue({ message });
    if (origin.skillType === 'flow') this.trackQueuedFlowPrompt(handle);
    return handle.launched;
  }

  private renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string {
    return this.skillCatalog.catalog.renderSkillPrompt(skill, rawArgs, {
      sessionId: this.sessionContext.sessionId,
    });
  }

  private publishActivation(origin: SkillActivationOrigin): void {
    this.telemetry.track2('skill_invoked', {
      skill_name: origin.skillName,
      trigger: origin.trigger,
    });
    if (origin.skillType === 'flow') {
      this.telemetry.track2('flow_invoked', {
        flow_name: origin.skillName,
      });
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSkillService,
  AgentSkillService,
  ScopeActivation.OnScopeCreated,
  'skill',
);
