export class SkillParseError extends Error {
  readonly reason?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SkillParseError';
    if (cause !== undefined) this.reason = cause;
  }
}

export class UnsupportedSkillTypeError extends Error {
  readonly skillType: string;

  constructor(skillType: string) {
    super(
      `Skill type "${skillType}" is not supported; only "prompt", "inline", and "flow" are supported.`,
    );
    this.name = 'UnsupportedSkillTypeError';
    this.skillType = skillType;
  }
}
