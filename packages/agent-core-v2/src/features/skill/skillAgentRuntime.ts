import { randomUUID } from 'node:crypto';

import type {
  BundledSkillActivation,
  ContextMessage,
  SkillActivationOrigin,
} from '#/agent/contextMemory/types';
import { IAgentLoopService, type Turn } from '#/agent/loop/loop';
import { IAgentPromptService, reservePrompt, type PromptLaunchResult } from '#/agent/prompt/prompt';
import { promptMetadataTextFromContentParts } from '#/agent/prompt/promptMetadataText';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
} from '#/agent/runtime/agentRuntime';
import { IEventService } from '#/app/event/event';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2 } from '#/errors';
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
import { SkillActivated } from './skillOps';

export class SkillRuntime {
  constructor(private readonly context: AgentRuntimeContext<null>) {}

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

    const turn = await this.recordActivation(
      {
        kind: 'skill_activation',
        activationId: randomUUID(),
        skillName: skill.name,
        trigger: 'user-slash',
        skillType: skill.metadata.type,
        skillPath: skill.path,
        skillSource: skill.source,
        skillArgs: input.args,
        attachments: input.attachments,
      },
      content,
    );
    if (turn === undefined) {
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
    const prepared = input.skills.map((skill) => this.prepareBundled(skill));
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
          attachments: input.attachments,
        },
      });
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
    return (await prompt.enqueue({ message })).launched;
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
    if (origin.skillType === 'flow') {
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
