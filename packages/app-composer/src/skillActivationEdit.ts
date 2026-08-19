// packages/app-composer/src/skillActivationEdit.ts
// Undo ("edit & resend") support for skill-activation turns. The daemon
// records an activation as origin skill_activation + skillName/skillArgs; the
// args are the ONLY user-authored text available for a composer refill. Two
// refill forms exist, and which one applies depends on the args' shape:
//
//   - Pill-composed activation (args carry EXACTLY ONE revivable skill pill
//     and it is the activated skill): the args ARE the original message, so
//     the refill is verbatim — but only a pill-capable composer (desktop) may
//     take it. A plain textarea (web) would resend raw markdown as a plain
//     prompt and silently drop the activation.
//   - Everything else (slash-typed bare args, or args with extra skill links
//     whose revival would degrade): refill the SYNTHESIZED command form
//     `/skill:<name> <args>`. The submit path resolves that prefix back into
//     an activateSkill call with the same name/args, so the resend replays
//     the original activation exactly — on both composers.
//
// A skill name with SPACES can't ride the space-delimited command form (the
// head parse would split mid-name), so those turns stay non-editable.

import { parseMentionLinks } from './composerTextDoc';

export interface SkillActivationRef {
  readonly name: string;
  readonly args?: string;
}

/** True when the activation's args carry EXACTLY ONE revivable skill mention
 *  and it is the activated skill (the mention-composed send path). Slash-typed
 *  activations have bare args with no pill — and args carrying EXTRA skill
 *  links would revive into multiple pills, whose resend downgrades to a plain
 *  prompt and silently drops the activation. */
export function skillActivationHasPill(act: SkillActivationRef): boolean {
  const skills = parseMentionLinks(act.args ?? '').filter((m) => m.attrs.kind === 'skill');
  return skills.length === 1 && skills[0]!.attrs.name === act.name;
}

/** The composer refill text for undoing a skill-activation turn, or null when
 *  the turn must stay non-editable. `revivePill` marks a pill-capable composer
 *  (desktop); a plain-text composer (web) only gets the synthesized command
 *  form. */
export function skillActivationEditText(
  act: SkillActivationRef,
  opts: { revivePill: boolean },
): string | null {
  if (skillActivationHasPill(act)) {
    return opts.revivePill ? (act.args ?? '') : null;
  }
  if (act.name.includes(' ')) return null;
  const args = act.args ?? '';
  return `/skill:${act.name}${args.length > 0 ? ` ${args}` : ''}`;
}

/** Whether undo ("edit & resend") may be offered on a skill-activation turn. */
export function canUndoSkillActivation(act: SkillActivationRef, opts: { revivePill: boolean }): boolean {
  return skillActivationEditText(act, opts) !== null;
}
