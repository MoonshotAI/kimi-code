import { randomUUID } from 'node:crypto';

import type { ActivateSkillPayload } from '#/rpc';
import type { ContentPart } from '@moonshot-ai/kosong';

import type { Agent } from '..';
import { ErrorCodes, KimiError } from '#/errors';
import { isUserActivatableSkillType } from '../../skill';
import type { SkillActivationOrigin } from '../context';
import { renderUserSlashSkillPrompt } from './prompt';
import type { SkillRegistry } from './types';

export type { SkillRegistry } from './types';

export class SkillManager {
  constructor(
    protected readonly agent: Agent,
    public readonly registry: SkillRegistry,
  ) {}

  activate(input: ActivateSkillPayload): void {
    const skill = this.registry.getSkill(input.name);
    if (skill === undefined) {
      throw new KimiError(ErrorCodes.SKILL_NOT_FOUND, `Skill "${input.name}" was not found`);
    }
    if (!isUserActivatableSkillType(skill.metadata.type)) {
      throw new KimiError(ErrorCodes.SKILL_TYPE_UNSUPPORTED, `Skill "${skill.name}" cannot be activated by the user`);
    }

    const skillArgs = input.args ?? '';
    const skillContent = this.registry.renderSkillPrompt(skill, skillArgs);
    const wrapped = [
      {
        type: 'text' as const,
        text: renderUserSlashSkillPrompt({
          skillName: skill.name,
          skillArgs,
          skillContent,
          skillSource: skill.source,
          skillDir: skill.dir,
        }),
      },
    ];

    this.recordActivation(
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
      wrapped,
    );
  }

  recordActivation(
    origin: SkillActivationOrigin,
    input?: readonly ContentPart[] | undefined,
  ): void {
    this.agent.emitEvent({
      type: 'skill.activated',
      activationId: origin.activationId,
      skillName: origin.skillName,
      trigger: origin.trigger,
      skillArgs: origin.skillArgs,
      skillPath: origin.skillPath,
      skillSource: origin.skillSource,
    });
    this.agent.telemetry.track('skill_invoked', {
      skill_name: origin.skillName,
      trigger: origin.trigger,
    });
    if (origin.skillType === 'flow') {
      this.agent.telemetry.track('flow_invoked', {
        flow_name: origin.skillName,
      });
    }
    if (input !== undefined) {
      this.agent.turn.prompt(input, origin);
    }
  }
}
