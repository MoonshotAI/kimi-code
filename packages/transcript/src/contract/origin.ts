import type { TranscriptSkillActivation, TranscriptUserOrigin } from '../model/frame';
import type { TranscriptUserIdentity } from '../model/identity';
import type { TurnOrigin } from '../model/turn';

export function projectTranscriptUserOrigin(origin: unknown): TranscriptUserOrigin | undefined {
  const candidate = origin as {
    readonly kind?: unknown;
    readonly skillActivations?: unknown;
    readonly clientMetadata?: unknown;
    readonly trigger?: unknown;
    readonly skillName?: unknown;
    readonly skillArgs?: unknown;
    readonly actor?: unknown;
  } | undefined;
  if (candidate?.kind !== 'user' && candidate?.kind !== 'skill_activation') return undefined;
  const clientMetadata = Array.isArray(candidate.clientMetadata)
    ? candidate.clientMetadata.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
    : [];
  const rawActor = candidate.actor as { userId?: unknown; displayName?: unknown } | undefined;
  const actor: TranscriptUserIdentity | undefined =
    typeof rawActor?.userId === 'string' && rawActor.userId.length > 0 &&
    typeof rawActor.displayName === 'string' && rawActor.displayName.length > 0
      ? { userId: rawActor.userId, displayName: rawActor.displayName }
      : undefined;
  if (candidate.kind === 'skill_activation') {
    if (candidate.trigger !== 'user-slash') return undefined;
    if (typeof candidate.skillName !== 'string' || candidate.skillName.length === 0) return undefined;
    return {
      kind: 'skill_activation',
      trigger: 'user-slash',
      skillName: candidate.skillName,
      skillArgs: typeof candidate.skillArgs === 'string' ? candidate.skillArgs : undefined,
      clientMetadata: clientMetadata.length > 0 ? clientMetadata : undefined,
      actor,
    };
  }
  if (!Array.isArray(candidate.skillActivations) && clientMetadata.length === 0 && actor === undefined) return { kind: 'user' };
  const skillActivations = (Array.isArray(candidate.skillActivations) ? candidate.skillActivations : []).flatMap((activation): TranscriptSkillActivation[] => {
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
    clientMetadata: clientMetadata.length > 0 ? clientMetadata : undefined,
    skillActivations: skillActivations.length > 0 ? skillActivations : undefined,
    actor,
  };
}

export function projectTranscriptUserTurnOrigin(origin: unknown): TurnOrigin {
  return { kind: 'user', payload: projectTranscriptUserOrigin(origin) ?? { kind: 'user' } };
}
