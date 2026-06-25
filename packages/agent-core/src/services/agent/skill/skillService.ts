import { randomUUID } from 'node:crypto';

import type { ContentPart } from '@moonshot-ai/kosong';

import type { SkillActivationOrigin } from '../../../agent/context';
import {
  renderModelToolSkillPrompt,
  renderUserSlashSkillPrompt,
} from '../../../agent/skill/prompt';
import { Disposable, registerSingleton, SyncDescriptor } from '../../../di';
import { ErrorCodes, KimiError } from '../../../errors';
import type { ExecutableToolResult } from '../../../loop';
import {
  isInlineSkillType,
  isUserActivatableSkillType,
  type SkillCatalog,
  type SkillDefinition,
} from '../../../skill';
import { IEventBus } from '../eventBus/eventBus';
import { IPromptService } from '../prompt/prompt';
import { ITelemetryService } from '../telemetry/telemetry';
import type { ContextMessage, Turn } from '../types';
import { IWireRecord } from '../wireRecord/wireRecord';
import {
  IAgentSkillService,
  type AgentSkillServiceOptions,
  type ModelSkillActivationInput,
  type SkillActivationInput,
} from './skill';

declare module '../types' {
  interface WireRecordMap {
    'skill.activate': {
      origin: SkillActivationOrigin;
    };
  }
}

export class AgentSkillService extends Disposable implements IAgentSkillService {
  declare readonly _serviceBrand: undefined;

  private readonly catalog: SkillCatalog | undefined;

  constructor(
    options: AgentSkillServiceOptions = {},
    @IPromptService private readonly prompt: IPromptService,
    @IEventBus private readonly events: IEventBus,
    @IWireRecord private readonly wireRecord: IWireRecord,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    this.catalog = options.catalog === null ? undefined : options.catalog;
    this._register(
      this.wireRecord.register('skill.activate', (record) => {
        this.publishActivation(record.origin);
      }),
    );
  }

  activate(input: SkillActivationInput): Turn {
    const skill = this.catalog?.getSkill(input.name);
    if (skill === undefined) {
      throw new KimiError(ErrorCodes.SKILL_NOT_FOUND, `Skill "${input.name}" was not found`);
    }
    if (!isUserActivatableSkillType(skill.metadata.type)) {
      throw new KimiError(
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
    ];

    return this.recordActivation(
      {
        kind: 'skill_activation',
        activationId: randomUUID(),
        skillName: skill.name,
        trigger: 'user-slash',
        skillType: skill.metadata.type,
        skillPath: skill.path,
        skillSource: skill.source,
        skillArgs: input.args,
      },
      content,
    )!;
  }

  activateFromModel(input: ModelSkillActivationInput): ExecutableToolResult {
    const skill = this.catalog?.getSkill(input.name);
    if (skill === undefined) {
      return errorResult(`Skill "${input.name}" not found in the current skill listing.`);
    }
    if (skill.metadata.disableModelInvocation === true) {
      return errorResult(
        `Skill "${input.name}" can only be triggered by the user (model invocation is disabled).`,
      );
    }
    if (!isInlineSkillType(skill.metadata.type)) {
      return errorResult(
        `Skill "${skill.name}" is not an inline skill and cannot be invoked by the model in v1.`,
      );
    }

    const skillArgs = input.args ?? '';
    const queryDepth = input.queryDepth ?? 0;
    const trigger = queryDepth > 0 ? 'nested-skill' : 'model-tool';
    const origin: SkillActivationOrigin = {
      kind: 'skill_activation',
      activationId: randomUUID(),
      skillName: skill.name,
      skillArgs: skillArgs.length > 0 ? skillArgs : undefined,
      trigger,
      skillType: skill.metadata.type,
      skillPath: skill.path,
      skillSource: skill.source,
    };
    const skillContent = this.renderSkillPrompt(skill, skillArgs);
    this.recordActivation(
      origin,
      [
        {
          type: 'text',
          text: renderModelToolSkillPrompt({
            skillName: skill.name,
            skillArgs,
            skillContent,
            skillSource: skill.source,
            skillDir: skill.dir,
            trigger,
          }),
        },
      ],
      'steer',
    );
    return {
      output: `Skill "${skill.name}" loaded inline. Follow its instructions.`,
    };
  }

  private recordActivation(
    origin: SkillActivationOrigin,
    input?: readonly ContentPart[],
    delivery: 'prompt' | 'steer' = 'prompt',
  ): Turn | undefined {
    this.wireRecord.append({ type: 'skill.activate', origin });
    this.publishActivation(origin);

    if (input === undefined) return undefined;
    const message: ContextMessage = {
      role: 'user',
      content: [...input],
      toolCalls: [],
      origin,
    };
    return delivery === 'steer' ? this.prompt.steer(message) : this.prompt.prompt(message);
  }

  private renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string {
    const catalog = this.requireCatalog();
    return catalog.renderSkillPrompt(skill, rawArgs);
  }

  private publishActivation(origin: SkillActivationOrigin): void {
    this.events.emit({
      type: 'skill.activated',
      activationId: origin.activationId,
      skillName: origin.skillName,
      trigger: origin.trigger,
      skillArgs: origin.skillArgs,
      skillPath: origin.skillPath,
      skillSource: origin.skillSource,
    });
    if (this.wireRecord.restoring !== null) return;
    this.telemetry.track('skill_invoked', {
      skill_name: origin.skillName,
      trigger: origin.trigger,
    });
    if (origin.skillType === 'flow') {
      this.telemetry.track('flow_invoked', {
        flow_name: origin.skillName,
      });
    }
  }

  private requireCatalog(): SkillCatalog {
    if (this.catalog !== undefined) return this.catalog;
    throw new KimiError(ErrorCodes.SKILL_NOT_FOUND, 'Skill catalog is not available');
  }
}

function errorResult(message: string): ExecutableToolResult {
  return { isError: true, output: message };
}

registerSingleton(
  IAgentSkillService,
  new SyncDescriptor(AgentSkillService, [{}], true),
);
