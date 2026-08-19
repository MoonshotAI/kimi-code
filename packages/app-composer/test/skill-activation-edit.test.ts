import { describe, expect, it } from 'vitest';
import {
  canUndoSkillActivation,
  skillActivationEditText,
  skillActivationHasPill,
} from '../src/skillActivationEdit';

const PILL_ARGS = '[deploy](kimi-code://skill/deploy) 帮我发一版';
const BARE_ARGS = '帮我发一版';

describe('skillActivationHasPill', () => {
  it('true when args carry exactly the activated skill as a pill', () => {
    expect(skillActivationHasPill({ name: 'deploy', args: PILL_ARGS })).toBe(true);
  });

  it('false for slash-typed bare args (no pill)', () => {
    expect(skillActivationHasPill({ name: 'deploy', args: BARE_ARGS })).toBe(false);
  });

  it('false when the pill names a DIFFERENT skill', () => {
    expect(
      skillActivationHasPill({ name: 'deploy', args: '[release](kimi-code://skill/release) go' }),
    ).toBe(false);
  });

  it('false when args carry extra skill links (revival would degrade)', () => {
    const args = '[deploy](kimi-code://skill/deploy) and [release](kimi-code://skill/release)';
    expect(skillActivationHasPill({ name: 'deploy', args })).toBe(false);
  });

  it('false without args', () => {
    expect(skillActivationHasPill({ name: 'deploy' })).toBe(false);
  });
});

describe('skillActivationEditText', () => {
  it('pill-composed args refill verbatim on a pill-capable composer', () => {
    expect(skillActivationEditText({ name: 'deploy', args: PILL_ARGS }, { revivePill: true })).toBe(
      PILL_ARGS,
    );
  });

  it('pill-composed args stay non-editable on a plain-text composer', () => {
    expect(skillActivationEditText({ name: 'deploy', args: PILL_ARGS }, { revivePill: false })).toBeNull();
    expect(canUndoSkillActivation({ name: 'deploy', args: PILL_ARGS }, { revivePill: false })).toBe(false);
  });

  it('slash-typed bare args refill as the synthesized command on both composers', () => {
    for (const revivePill of [true, false]) {
      expect(skillActivationEditText({ name: 'deploy', args: BARE_ARGS }, { revivePill })).toBe(
        `/skill:deploy ${BARE_ARGS}`,
      );
    }
  });

  it('synthesizes the bare command when the activation had no args', () => {
    expect(skillActivationEditText({ name: 'deploy' }, { revivePill: false })).toBe('/skill:deploy');
  });

  it('args with extra skill links take the command form (no pill revival)', () => {
    const args = '[deploy](kimi-code://skill/deploy) and [release](kimi-code://skill/release)';
    expect(skillActivationEditText({ name: 'deploy', args }, { revivePill: true })).toBe(
      `/skill:deploy ${args}`,
    );
  });

  it('a skill name with spaces cannot ride the command form — non-editable', () => {
    expect(
      skillActivationEditText({ name: 'write goal', args: 'x' }, { revivePill: true }),
    ).toBeNull();
    expect(canUndoSkillActivation({ name: 'write goal', args: 'x' }, { revivePill: true })).toBe(false);
  });
});
