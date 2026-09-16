import type { TranscriptSkillActivation, TranscriptUserOrigin } from '../model/frame';

export function projectTranscriptUserOrigin(origin: unknown): TranscriptUserOrigin | undefined {
  const candidate = origin as {
    readonly kind?: unknown;
    readonly skillActivations?: unknown;
    readonly trigger?: unknown;
    readonly skillName?: unknown;
    readonly skillArgs?: unknown;
  } | undefined;
  if (candidate?.kind === 'skill_activation') {
    if (candidate.trigger !== 'user-slash') return undefined;
    if (typeof candidate.skillName !== 'string' || candidate.skillName.length === 0) return undefined;
    return {
      kind: 'skill_activation',
      trigger: 'user-slash',
      skillName: candidate.skillName,
      skillArgs: typeof candidate.skillArgs === 'string' ? candidate.skillArgs : undefined,
    };
  }
  if (candidate?.kind !== 'user') return undefined;
  if (!Array.isArray(candidate.skillActivations)) return { kind: 'user' };
  const skillActivations = candidate.skillActivations.flatMap((activation): TranscriptSkillActivation[] => {
    if (typeof activation !== 'object' || activation === null) return [];
    const value = activation as { readonly skillName?: unknown; readonly skillArgs?: unknown };
    if (typeof value.skillName !== 'string') return [];
    return [{
      skillName: value.skillName,
      skillArgs: typeof value.skillArgs === 'string' ? value.skillArgs : undefined,
    }];
  });
  return {
    kind: 'user',
    skillActivations: skillActivations.length > 0 ? skillActivations : undefined,
  };
}
