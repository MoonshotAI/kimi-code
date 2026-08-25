import { randomUUID } from 'node:crypto';

import type {
  BundledSkillActivation,
  ContextMessage,
  SkillActivationOrigin,
} from '#/agent/contextMemory/types';
import { IAgentLoopService, type Turn } from '#/agent/loop/loop';
import {
  IAgentPromptService,
  reservePrompt,
  type PromptHandle,
  type PromptLaunchResult,
} from '#/agent/prompt/prompt';
import { promptMetadataTextFromContentParts } from '#/agent/prompt/promptMetadataText';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
} from '#/agent/runtime/agentRuntime';
import { IEventService } from '#/app/event/event';
import { IFlagService } from '#/app/flag/flag';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2 } from '#/errors';
import { FLOW_FLAG_ID, IAgentFlowService } from '#/features/flow/flow';
import { isProjectedFlowSkill } from '#/features/flow/flowsSkillSource';
import type { ContentPart } from '#/kosong/contract/message';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { applyPromptMetadataUpdate } from '#/session/sessionMetadata/promptMetadata';

import { isUserActivatableSkillType, type SkillDefinition } from './catalog/types';
import { promptMetadataTextFromSkill, renderUserSlashSkillPrompt } from './prompt';
import { ISessionSkillCatalog } from './session/skillCatalog';
import type {
  PromptSkillActivation,
  PromptWithSkillsInput,
  PromptWithSkillsResult,
  SkillActivationInput,
} from './skill';
import { ISkillActivationDataService } from './skillActivationData';
import { SkillActivated } from './skillOps';

export class SkillRuntime {
  constructor(private readonly context: AgentRuntimeContext<null>) {}

  private readonly queuedFlowPrompts = new Set<string>();

  private trackQueuedFlowPrompt(handle: PromptHandle): void {
    this.queuedFlowPrompts.add(handle.id);
    void handle.completion.then(() => {
      this.queuedFlowPrompts.delete(handle.id);
    });
  }

  private abortIfFlowDisabled(handle: PromptHandle): void {
    if (this.context.get(IFlagService).enabled(FLOW_FLAG_ID)) return;
    this.context.get(IAgentPromptService).abort(handle.id);
    throw new Error2(
      ErrorCodes.REQUEST_INVALID,
      'The flow feature was disabled while this activation was being queued; the prompt was aborted.',
    );
  }

  abortQueuedFlowPrompts(): void {
    const queued = Array.from(this.queuedFlowPrompts);
    for (const promptId of queued) {
      try {
        this.context.get(IAgentPromptService).abort(promptId);
      } catch {
        this.queuedFlowPrompts.delete(promptId);
      }
    }
  }

  async activate(input: SkillActivationInput): Promise<PromptLaunchResult> {
    const catalog = this.context.get(ISessionSkillCatalog);
    await catalog.ready;
    const skill = catalog.catalog.getSkill(input.name);
    if (skill === undefined) {
      throw new Error2(ErrorCodes.SKILL_NOT_FOUND, `Skill "${input.name}" was not found`);
    }
    if (!isUserActivatableSkillType(skill.metadata.type)) {
      throw new Error2(
        ErrorCodes.SKILL_TYPE_UNSUPPORTED,
        `Skill "${skill.name}" cannot be activated by the user`,
      );
    }
    if (isProjectedFlowSkill(skill.name, skill.metadata.type)) {
      if (this.context.agent.agentId !== MAIN_AGENT_ID) {
        throw new Error2(
          ErrorCodes.REQUEST_INVALID,
          `Flow skill "${skill.name}" can only be activated on the main agent`,
        );
      }
      this.rejectWhileFlowRunActive();
    }

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
    const activationData = this.context.get(ISkillActivationDataService);
    activationData.put(origin.activationId, skill.data);
    const flow = this.context.get(IAgentFlowService);
    let turn: Turn | undefined;
    try {
      turn = await this.recordActivation(origin, content);
    } catch (error) {
      activationData.take(origin.activationId);
      flow.discardPendingActivation(origin.activationId);
      throw error;
    }
    if (turn === undefined) {
      activationData.take(origin.activationId);
      flow.discardPendingActivation(origin.activationId);
      throw new Error2(
        ErrorCodes.TURN_AGENT_BUSY,
        'Cannot activate skill while another turn is active',
      );
    }
    if (this.context.agent.agentId === MAIN_AGENT_ID) {
      await applyPromptMetadataUpdate(
        {
          metadata: this.context.get(ISessionMetadata),
          eventService: this.context.get(IEventService),
          sessionId: this.context.get(ISessionContext).sessionId,
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
    const catalog = this.context.get(ISessionSkillCatalog);
    await catalog.ready;
    const activationData = this.context.get(ISkillActivationDataService);
    const flow = this.context.get(IAgentFlowService);
    const prepared: {
      origin: SkillActivationOrigin;
      part: ContentPart;
      entry: BundledSkillActivation;
    }[] = [];
    const discardPrepared = (): void => {
      for (const activation of prepared) {
        activationData.take(activation.origin.activationId);
      }
    };
    try {
      for (const skill of input.skills) prepared.push(this.prepareBundled(skill));
    } catch (error) {
      discardPrepared();
      throw error;
    }
    const flowActivations = prepared.filter((activation) =>
      isProjectedFlowSkill(activation.origin.skillName, activation.origin.skillType),
    );
    if (flowActivations.length > 1) {
      discardPrepared();
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        'A prompt can bundle at most one flow skill: each flow run needs its own prompt.',
      );
    }
    if (flowActivations.length > 0 && this.context.agent.agentId !== MAIN_AGENT_ID) {
      discardPrepared();
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        'Flow skills can only be activated on the main agent',
      );
    }
    try {
      if (flowActivations.length > 0) this.rejectWhileFlowRunActive();
      if (this.context.agent.agentId === MAIN_AGENT_ID) {
        await applyPromptMetadataUpdate(
          {
            metadata: this.context.get(ISessionMetadata),
            eventService: this.context.get(IEventService),
            sessionId: this.context.get(ISessionContext).sessionId,
          },
          promptMetadataTextFromContentParts(input.input),
        );
      }
      if (flowActivations.length > 0) this.rejectWhileFlowRunActive();
    } catch (error) {
      discardPrepared();
      throw error;
    }
    for (const activation of prepared) {
      void this.recordActivation(activation.origin);
    }
    const prompt = this.context.get(IAgentPromptService);
    const reservation = reservePrompt(prompt);
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
            flow.discardPendingActivation(id);
            activationData.take(id);
          }
        });
        this.abortIfFlowDisabled(handle);
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
    const catalog = this.context.get(ISessionSkillCatalog);
    const skill = catalog.catalog.getSkill(input.name);
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
    this.context.get(ISkillActivationDataService).put(origin.activationId, skill.data);
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

  private rejectWhileFlowRunActive(): void {
    if (!this.context.get(IFlagService).enabled(FLOW_FLAG_ID)) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        'The flow feature is disabled ([experimental].flow); enable it before activating a flow skill.',
      );
    }
    const flow = this.context.get(IAgentFlowService);
    if (!flow.run().active && !flow.hasPendingActivation()) return;
    throw new Error2(
      ErrorCodes.REQUEST_INVALID,
      'A flow run is already active or queued in this session. Finish or abort it (FlowAbort) before starting another flow.',
    );
  }

  private async recordActivation(
    origin: SkillActivationOrigin,
    input?: readonly ContentPart[],
  ): Promise<Turn | undefined> {
    await this.context.dispatch(
      new SkillActivated({
        agentId: this.context.agent.agentId,
        activationId: origin.activationId,
        skillName: origin.skillName,
        trigger: origin.trigger,
        skillArgs: origin.skillArgs,
        skillPath: origin.skillPath,
        skillSource: origin.skillSource,
        skillType: origin.skillType,
      }),
    );
    this.publishActivation(origin);

    if (input === undefined) return undefined;
    const message: ContextMessage = {
      role: 'user',
      content: [...input],
      toolCalls: [],
      origin,
    };
    const prompt = this.context.get(IAgentPromptService);
    if (this.context.get(IAgentLoopService).status().state === 'running') {
      return prompt.inject(message);
    }
    const handle = await prompt.enqueue({ message });
    if (isProjectedFlowSkill(origin.skillName, origin.skillType)) {
      this.trackQueuedFlowPrompt(handle);
      try {
        this.abortIfFlowDisabled(handle);
      } catch (error) {
        this.context.get(IAgentFlowService).discardPendingActivation(origin.activationId);
        this.context.get(ISkillActivationDataService).take(origin.activationId);
        throw error;
      }
    }
    return handle.launched;
  }

  private renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string {
    return this.context.get(ISessionSkillCatalog).catalog.renderSkillPrompt(skill, rawArgs, {
      sessionId: this.context.get(ISessionContext).sessionId,
    });
  }

  private publishActivation(origin: SkillActivationOrigin): void {
    const telemetry = this.context.get(ITelemetryService);
    telemetry.track2('skill_invoked', {
      skill_name: origin.skillName,
      trigger: origin.trigger,
    });
    if (isProjectedFlowSkill(origin.skillName, origin.skillType)) {
      telemetry.track2('flow_invoked', {
        flow_name: origin.skillName,
      });
    }
  }
}

export const AgentSkill = defineAgentRuntimeContract<SkillRuntime>('skill');

export const skillAgentRuntimeProvider = defineAgentRuntimeProvider<null, SkillRuntime>(AgentSkill, {
  id: 'skill',
  createApi: (context) => new SkillRuntime(context),
});
