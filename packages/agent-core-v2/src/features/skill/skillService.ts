import { randomUUID } from 'node:crypto';

import { createDecorator } from '#/_base/di/instantiation';
import type {
  BundledSkillActivation,
  PromptOrigin,
  SkillActivationOrigin,
} from '#/agent/contextMemory/types';
import { IAgentLoopService, type PromptLaunchResult, type Turn } from '#/agent/loop/loop';
import { promptMetadataTextFromContentParts } from '#/agent/prompt/promptMetadataText';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IEventService } from '#/app/event/event';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2 } from '#/errors';
import type { ContentPart } from '#human/llm/message';
import { skillActivationPart } from '#human/agent/origin';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { applyPromptMetadataUpdate } from '#/session/sessionMetadata/promptMetadata';
import { IEventDispatcher } from '#/state/eventDispatcher';

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

export interface ModelToolSkillContext {
  readonly queryDepth: number;
  readonly workspaceDir?: string;
}

export interface IAgentSkillService {
  readonly _serviceBrand: undefined;
  activate(input: SkillActivationInput): Promise<PromptLaunchResult>;
  promptWithSkills(input: PromptWithSkillsInput): Promise<PromptWithSkillsResult>;
  recordModelToolActivation(origin: SkillActivationOrigin, queryDepth?: number): void;
  modelToolContext(): ModelToolSkillContext;
}

export const IAgentSkillService = createDecorator<IAgentSkillService>('agentSkillService');

export class AgentSkillService implements IAgentSkillService {
  declare readonly _serviceBrand: undefined;
  private modelToolParent?: ModelToolSkillContext & { readonly turnId: number };
  private ambiguousModelToolTurnId?: number;

  constructor(
    @ISessionSkillCatalog private readonly catalog: ISessionSkillCatalog,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  async activate(input: SkillActivationInput): Promise<PromptLaunchResult> {
    const catalog = this.catalog;
    await catalog.ready;
    const skill = catalog.catalog.getSkill(input.name, input.path);
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
      attachments: input.attachments,
      clientMetadata: input.clientMetadata,
    };
    const turn = await this.recordActivation(origin, content, input.promptId);
    if (turn?.id !== undefined) this.rememberModelToolParent(origin, turn.id);
    if (turn === undefined) {
      throw new Error2(
        ErrorCodes.TURN_AGENT_BUSY,
        'Cannot activate skill while another turn is active',
      );
    }
    await turn.ready.catch(() => undefined);
    if (turn.id === undefined) {
      throw new Error2(ErrorCodes.INTERNAL, 'Skill activation turn ended before it started');
    }
    if (this.scopeContext.agentContext.agentId === MAIN_AGENT_ID) {
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
    const catalog = this.catalog;
    await catalog.ready;
    const prepared = input.skills.map((skill) => this.prepareBundled(skill));
    if (this.scopeContext.agentContext.agentId === MAIN_AGENT_ID) {
      await applyPromptMetadataUpdate(
        {
          metadata: this.metadata,
          eventService: this.eventService,
          sessionId: this.sessionContext.sessionId,
        },
        promptMetadataTextFromContentParts(input.input, input.clientMetadata),
      );
    }
    for (const activation of prepared) {
      void this.recordActivation(activation.origin);
    }
    const status = this.loop.snapshot();
    const steerable = input.steerIfActive === true && status.state === 'running';
    const submission = {
      message: {
        role: 'user' as const,
        content: [...prepared.map((activation) => activation.part), ...input.input],
      },
      meta: {
        promptId: input.promptId,
        origin: {
          kind: 'user',
          skillActivations: prepared.map((activation) => activation.entry),
          clientMetadata: input.clientMetadata,
          attachments: input.attachments,
        } as PromptOrigin,
      },
    };
    const { id } = steerable ? this.loop.sendNow(submission) : this.loop.submit(submission);
    const handle = this.loop.promptHandle(id)!;
    if (!steerable && (status.state === 'running' || status.paused || status.queue.length > 0)) {
      if (prepared.length === 1) {
        void handle.launched.then((turn) => {
          if (turn?.id !== undefined) this.rememberModelToolParent(prepared[0]!.origin, turn.id);
        });
      }
      return { prompt_id: id, created_at: handle.createdAt, state: 'queued', steered: false };
    }
    await Promise.race([handle.launched, handle.completion]);
    const turn = await handle.launched;
    if (turn === undefined && handle.state !== 'blocked') {
      throw new Error2(ErrorCodes.INTERNAL, 'promptWithSkills failed to launch a turn');
    }
    if (turn?.id !== undefined) {
      if (prepared.length === 1) this.rememberModelToolParent(prepared[0]!.origin, turn.id);
      else if (this.modelToolParent?.turnId === turn.id) this.modelToolParent = undefined;
    }
    if (turn !== undefined) await turn.ready.catch(() => undefined);
    return {
      turn_id: turn?.id,
      prompt_id: id,
      created_at: handle.createdAt,
      state: handle.state === 'blocked' ? 'blocked' : 'running',
      steered: steerable,
    };
  }

  recordModelToolActivation(origin: SkillActivationOrigin, queryDepth?: number): void {
    const turnId = this.loop.snapshot().activeTurnId;
    if (turnId !== undefined) this.rememberModelToolParent(origin, turnId, queryDepth);
    void this.recordActivation(origin);
  }

  modelToolContext(): ModelToolSkillContext {
    const status = this.loop.snapshot();
    if (status.state !== 'running' || status.activeTurnId === undefined || this.modelToolParent?.turnId !== status.activeTurnId) {
      return { queryDepth: 0 };
    }
    return {
      queryDepth: this.modelToolParent.queryDepth,
      workspaceDir: this.modelToolParent.workspaceDir,
    };
  }

  private rememberModelToolParent(origin: SkillActivationOrigin, turnId: number, resolvedQueryDepth?: number): void {
    if (this.ambiguousModelToolTurnId === turnId) return;
    const parent = this.modelToolParent?.turnId === turnId ? this.modelToolParent : undefined;
    const workspaceDir = this.catalog.catalog.listSkills().find((skill) => skill.path === origin.skillPath)?.workspaceDir;
    if (origin.trigger === 'model-tool' && parent !== undefined && parent.workspaceDir !== workspaceDir) {
      this.modelToolParent = undefined;
      this.ambiguousModelToolTurnId = turnId;
      return;
    }
    const queryDepth = resolvedQueryDepth ?? (origin.trigger === 'nested-skill' ? (parent?.queryDepth ?? 0) + 1 : 1);
    this.modelToolParent = { turnId, queryDepth, workspaceDir };
  }

  private prepareBundled(input: PromptSkillActivation): {
    readonly origin: SkillActivationOrigin;
    readonly part: ContentPart;
    readonly entry: BundledSkillActivation;
  } {
    const catalog = this.catalog;
    const skill = catalog.catalog.getSkill(input.name, input.path);
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
    const activationId = randomUUID();
    const origin: SkillActivationOrigin = {
      kind: 'skill_activation',
      activationId,
      skillName: skill.name,
      trigger: 'user-slash',
      skillType: skill.metadata.type,
      skillPath: skill.path,
      skillSource: skill.source,
      skillArgs: input.args,
    };
    return {
      origin,
      part: skillActivationPart(
        renderUserSlashSkillPrompt({
          skillName: skill.name,
          skillArgs,
          skillContent,
          skillSource: skill.source,
          skillDir: skill.dir,
        }),
        activationId,
      ),
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
    promptId?: string,
  ): Promise<Turn | undefined> {
    await this.dispatcher.dispatch(
      new SkillActivated({
        agentId: this.scopeContext.agentContext.agentId,
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
    const status = this.loop.snapshot();
    const running = status.state === 'running';
    const submission = {
      message: { role: 'user' as const, content: [...input] },
      meta: { promptId, origin },
    };
    const { id } = running ? this.loop.sendNow(submission) : this.loop.submit(submission);
    return this.loop.promptHandle(id)!.launched;
  }

  private renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string {
    return this.catalog.catalog.renderSkillPrompt(skill, rawArgs, {
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
