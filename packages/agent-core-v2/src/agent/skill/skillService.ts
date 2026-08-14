/**
 * `skill` domain — `IAgentSkillService` implementation.
 *
 * Resolves skills from the session catalog, renders the activation prompt,
 * records the activation as a `skill.activate` fact through `wire.dispatch`
 * (a stateless, identity-apply Op), derives the `skill.activated` event
 * through the Op's `toEvent`, drives user-slash activations into a new turn via
 * `prompt` (attachment parts from the caller ride the same user message after
 * the rendered prompt), settles `{turn_id}` for the caller, persists the
 * derived title/lastPrompt through `sessionMetadata` for the main agent only
 * (publishing the live update through `event`), and reports `skill_invoked` /
 * `flow_invoked` through `telemetry`. `promptWithSkills` submits one prompt
 * preceded by one or more skill activations that share the prompt's
 * `submissionId`, so the group launches as a single turn and undoes as one
 * unit; every skill is validated before anything is recorded, so an invalid
 * name rejects the whole submission. `wire.replay` reapplies the fact as a
 * no-op, so neither the event nor telemetry fires on resume (matching the
 * former `restoring` guard). Bound at Agent scope.
 */

import { randomUUID } from 'node:crypto';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import type { ContentPart } from '#/kosong/contract/message';

import type { ContextMessage, SkillActivationOrigin } from '#/agent/contextMemory/types';
import { promptMetadataTextFromSkill, renderUserSlashSkillPrompt } from './prompt';
import { promptMetadataTextFromContentParts } from '#/agent/prompt/promptMetadataText';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { Service } from '#/_base/di/service';
import { ErrorCodes, Error2 } from '#/errors';
import { isUserActivatableSkillType, type SkillDefinition } from '#/app/skillCatalog/types';
import { IAgentPromptService, type PromptLaunchResult } from '#/agent/prompt/prompt';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IWireService } from '#/wire/wire';
import {
  IAgentSkillService,
  type PromptWithSkillsInput,
  type SkillActivationInput,
} from './skill';
import { skillActivate } from './skillOps';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { IEventService } from '#/app/event/event';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { applyPromptMetadataUpdate } from '#/session/sessionMetadata/promptMetadata';

interface PreparedActivation {
  readonly origin: SkillActivationOrigin;
  readonly message: ContextMessage;
}

export class AgentSkillService extends Service implements IAgentSkillService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
    @IWireService private readonly wire: IWireService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {
    super();
  }

  async activate(input: SkillActivationInput): Promise<PromptLaunchResult> {
    await this.skillCatalog.ready;
    const prepared = this.prepare(input);
    this.recordActivation(prepared.origin);
    const turn = await (await this.prompt.enqueue({ message: prepared.message })).launched;
    if (turn === undefined) {
      throw new Error2(
        ErrorCodes.TURN_AGENT_BUSY,
        'Cannot activate skill while another turn is active',
      );
    }
    // Awaited (not fire-and-forget): the caller gets the launched turn id and
    // activation failures (unknown skill, busy) surface instead of vanishing.
    if (this.scopeContext.agentId === MAIN_AGENT_ID) {
      await this.updatePromptMetadata(promptMetadataTextFromSkill(input));
    }
    return { turn_id: turn.id };
  }

  async promptWithSkills(input: PromptWithSkillsInput): Promise<PromptLaunchResult | undefined> {
    if (input.input.length === 0) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'promptWithSkills requires a non-empty prompt');
    }
    await this.skillCatalog.ready;
    const submissionId = input.submissionId ?? randomUUID();
    const prepared = input.skills.map((skill) => this.prepare(skill, submissionId));
    if (this.scopeContext.agentId === MAIN_AGENT_ID) {
      await this.updatePromptMetadata(promptMetadataTextFromContentParts(input.input));
    }
    for (const activation of prepared) {
      this.recordActivation(activation.origin);
    }
    const handle = await this.prompt.enqueue({
      message: {
        role: 'user',
        content: [...input.input],
        toolCalls: [],
        origin: { kind: 'user', submissionId },
      },
      messagesBefore: prepared.map((activation) => activation.message),
    });
    if (handle.state === 'pending') return undefined;
    const turn = await handle.launched;
    return turn === undefined ? undefined : { turn_id: turn.id };
  }

  recordModelToolActivation(origin: SkillActivationOrigin): void {
    this.recordActivation(origin);
  }

  private prepare(input: SkillActivationInput, submissionId?: string): PreparedActivation {
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
      submissionId,
    };
    const message: ContextMessage = {
      role: 'user',
      content,
      toolCalls: [],
      origin,
    };
    return { origin, message };
  }

  private recordActivation(origin: SkillActivationOrigin): void {
    this.wire.dispatch(skillActivate({ origin }));
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

  private renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string {
    return this.skillCatalog.catalog.renderSkillPrompt(skill, rawArgs, {
      sessionId: this.sessionContext.sessionId,
    });
  }

  private async updatePromptMetadata(text: string | undefined): Promise<void> {
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

registerScopedService(
  LifecycleScope.Agent,
  IAgentSkillService,
  AgentSkillService,
  ScopeActivation.OnScopeCreated,
  'skill',
);
