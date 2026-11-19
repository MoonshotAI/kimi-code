
import { parseMentionLinks, serializeMention, type ComposerDocumentSnapshot } from '../../model';
import { parseSlash, skillIdentity, skillRefMatches, type SkillRef } from '@moonshot-ai/app-core/lib';

export interface SkillActivationRef {
  readonly name: string;
  readonly path?: string;
  readonly args?: string;
}

function skillActivationMatches(act: SkillActivationRef, ref: SkillRef): boolean {
  return skillRefMatches(act, { name: ref.name, path: ref.path || undefined });
}

function skillActivationPill(act: SkillActivationRef) {
  const skills = parseMentionLinks(act.args ?? '').filter((m) => m.attrs.kind === 'skill');
  return skills.length === 1 && skillActivationMatches(act, skills[0]!.attrs) ? skills[0] : undefined;
}

export function skillActivationHasPill(act: SkillActivationRef): boolean {
  return skillActivationPill(act) !== undefined;
}

export function skillActivationEditText(
  act: SkillActivationRef,
  opts: { revivePill: boolean; defaultPath?: string },
): string | null {
  const pill = skillActivationPill(act);
  if (pill !== undefined) {
    if (!opts.revivePill) return null;
    if (act.path === undefined || act.path === opts.defaultPath) return act.args ?? '';
    const args = act.args ?? '';
    const linked = serializeMention({ kind: 'skill', name: act.name, path: act.path });
    return `${args.slice(0, pill.start)}${linked}${args.slice(pill.end)}`;
  }
  if (act.name.includes(' ') || (act.path !== undefined && act.path !== opts.defaultPath)) return null;
  const args = act.args ?? '';
  return `/skill:${act.name}${args.length > 0 ? ` ${args}` : ''}`;
}

export function canUndoSkillActivation(act: SkillActivationRef, opts: { revivePill: boolean; defaultPath?: string }): boolean {
  return skillActivationEditText(act, opts) !== null;
}

export function skillActivationsMissingPills(
  acts: readonly SkillActivationRef[],
  text: string,
): SkillActivationRef[] {
  const remaining = parseMentionLinks(text)
    .filter((match) => match.attrs.kind === 'skill')
    .map((match) => match.attrs);
  const missing: SkillActivationRef[] = [];
  for (const act of acts) {
    const index = remaining.findIndex((pill) => skillActivationMatches(act, pill));
    if (index === -1) missing.push(act);
    else remaining.splice(index, 1);
  }
  return missing;
}

function bindSkillActivations(
  acts: readonly SkillActivationRef[],
  pills: readonly SkillRef[],
  defaultPath?: (name: string) => string | undefined,
): Array<number | undefined> | null {
  if (new Set(acts.map(skillIdentity)).size !== acts.length) return null;
  const actByPill: Array<number | undefined> = Array.from({ length: pills.length });
  const explicitActs = new Set<number>();
  for (const [pillIndex, pill] of pills.entries()) {
    if (!pill.path) continue;
    const actIndex = acts.findIndex((act) => skillActivationMatches(act, pill));
    if (actIndex === -1) return null;
    actByPill[pillIndex] = actIndex;
    explicitActs.add(actIndex);
  }
  for (const [pillIndex, pill] of pills.entries()) {
    if (pill.path) continue;
    const candidates = acts.flatMap((act, actIndex) =>
      act.name.toLowerCase() === pill.name.toLowerCase() ? [actIndex] : []);
    const pillDefaultPath = defaultPath?.(pill.name);
    const unclaimed = candidates.filter((candidate) => !explicitActs.has(candidate));
    let actIndex: number | undefined;
    if (candidates.length === 1) {
      actIndex = candidates[0];
    } else if (unclaimed.length === 1) {
      actIndex = unclaimed[0];
    } else if (pillDefaultPath !== undefined) {
      actIndex = candidates.find((candidate) => acts[candidate]?.path === pillDefaultPath);
    }
    if (actIndex === undefined) return null;
    actByPill[pillIndex] = actIndex;
  }
  const activationOrder = [...new Set(actByPill)];
  if (
    activationOrder.length !== acts.length ||
    activationOrder.some((actIndex, index) => actIndex !== index)
  ) return null;
  return actByPill;
}

export function skillActivationsEditText(
  acts: readonly SkillActivationRef[],
  text: string,
  opts: { revivePill: boolean; defaultPath?: (name: string) => string | undefined },
): string | null {
  if (!opts.revivePill) return null;
  if (acts.some((act) => (act.args ?? '') !== '')) return null;
  if (new Set(acts.map(skillIdentity)).size !== acts.length) return null;
  const pillCount = [...skillPillCounts(text).values()].reduce((sum, count) => sum + count, 0);
  if (pillCount < 2) return null;
  if (parseSlash(text) !== null) return null;
  const matches = parseMentionLinks(text).filter((match) => match.attrs.kind === 'skill');
  const actByPill = bindSkillActivations(acts, matches.map((match) => match.attrs), opts.defaultPath);
  if (actByPill === null) return null;
  let restored = text;
  for (let matchIndex = matches.length - 1; matchIndex >= 0; matchIndex--) {
    const match = matches[matchIndex]!;
    if (match.attrs.path) continue;
    const act = acts[actByPill[matchIndex]!]!;
    if (act.path === undefined || act.path === opts.defaultPath?.(act.name)) continue;
    const linked = serializeMention({ kind: 'skill', name: act.name, path: act.path });
    restored = `${restored.slice(0, match.start)}${linked}${restored.slice(match.end)}`;
  }
  return restored;
}

export function skillSnapshotWithVariantPaths(
  acts: readonly SkillActivationRef[],
  snapshot: ComposerDocumentSnapshot,
  opts: { defaultPath?: (name: string) => string | undefined },
): ComposerDocumentSnapshot {
  const pills: SkillRef[] = [];
  for (const paragraph of snapshot.doc.content ?? []) {
    for (const node of paragraph.content ?? []) {
      if (node.type !== 'mention' || node.attrs?.kind !== 'skill') continue;
      pills.push({ name: node.attrs.name as string, path: node.attrs.path as string });
    }
  }
  const actByPill = bindSkillActivations(acts, pills, opts.defaultPath);
  if (actByPill === null) return snapshot;
  let pillIndex = 0;
  let changed = false;
  const content = snapshot.doc.content?.map((paragraph) => ({
    ...paragraph,
    content: paragraph.content?.map((node) => {
      if (node.type !== 'mention' || node.attrs?.kind !== 'skill') return node;
      const act = acts[actByPill[pillIndex++]!]!;
      if (node.attrs.path || act.path === undefined) return node;
      changed = true;
      return { ...node, attrs: { ...node.attrs, path: act.path } };
    }),
  }));
  return changed ? { ...snapshot, doc: { ...snapshot.doc, content } } : snapshot;
}

export function skillActivationsMatchText(
  acts: readonly SkillActivationRef[],
  text: string,
): boolean {
  if (acts.length === 0) return false;
  if (skillActivationsMissingPills(acts, text).length > 0) return false;
  for (const match of parseMentionLinks(text)) {
    if (match.attrs.kind !== 'skill') continue;
    if (!acts.some((act) => skillActivationMatches(act, match.attrs))) return false;
  }
  return true;
}

export function canUndoSkillActivations(
  acts: readonly SkillActivationRef[],
  text: string,
  opts: { revivePill: boolean; defaultPath?: (name: string) => string | undefined },
): boolean {
  return skillActivationsEditText(acts, text, opts) !== null;
}

function skillPillCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of parseMentionLinks(text)) {
    if (match.attrs.kind !== 'skill') continue;
    const key = skillIdentity(match.attrs);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function skillActivationsBubbleText(
  acts: readonly SkillActivationRef[],
  text: string,
): string {
  const skillMatches = parseMentionLinks(text).filter((match) => match.attrs.kind === 'skill');
  const argumentInsertions: Array<{ at: number; text: string }> = [];
  const consumed = new Set<number>();
  const occurrences = acts.map((act) => {
    const index = skillMatches.findIndex((match, candidateIndex) =>
      !consumed.has(candidateIndex) && skillActivationMatches(act, match.attrs),
    );
    if (index === -1) return undefined;
    consumed.add(index);
    return skillMatches[index];
  });
  for (const [index, act] of acts.entries()) {
    const occurrence = occurrences[index];
    if (occurrence === undefined) continue;
    const args = act.args ?? '';
    if (args === '') continue;
    const visibleFromPill =
      occurrence === undefined
        ? text
        : text.slice(
            occurrence.end,
            skillMatches[skillMatches.indexOf(occurrence) + 1]?.start ?? text.length,
          );
    const argsHaveMentions = parseMentionLinks(args).length > 0;
    const comparableText = argsHaveMentions
      ? text.slice(occurrence.end)
      : visibleMentionText(visibleFromPill);
    const comparableArgs = argsHaveMentions ? args : visibleMentionText(args);
    if (hasAdjacentArgs(comparableText, comparableArgs)) continue;
    argumentInsertions.push({ at: occurrence.end, text: ` ${args}` });
  }

  const missingByPosition = new Map<number, string[]>();
  for (const [index, act] of acts.entries()) {
    if (occurrences[index] !== undefined) continue;
    const nextOccurrence = occurrences.slice(index + 1).find((item) => item !== undefined);
    const at = nextOccurrence?.start ?? (skillMatches.length === 0 ? 0 : text.length);
    const pill = serializeMention({ kind: 'skill', name: act.name, path: act.path ?? '' });
    const rendered = act.args ? `${pill} ${act.args}` : pill;
    missingByPosition.set(at, [...(missingByPosition.get(at) ?? []), rendered]);
  }

  const insertions: Array<{ at: number; text: string }> = [];
  for (const [at, rendered] of missingByPosition) {
    const joined = rendered.join(' ');
    if (at === 0) insertions.push({ at, text: `${joined}${text ? ' ' : ''}` });
    else if (at === text.length) {
      insertions.push({ at, text: `${/\s$/u.test(text) ? '' : ' '}${joined}` });
    } else {
      insertions.push({ at, text: `${joined} ` });
    }
  }
  insertions.push(...argumentInsertions);
  let body = text;
  for (const insertion of insertions.toSorted((left, right) => right.at - left.at)) {
    body = `${body.slice(0, insertion.at)}${insertion.text}${body.slice(insertion.at)}`;
  }
  return body;
}

function hasAdjacentArgs(text: string, args: string): boolean {
  const adjacent = text.trimStart();
  if (!adjacent.startsWith(args)) return false;
  if (adjacent.length === args.length || /\s$/u.test(args)) return true;
  return !/[\p{L}\p{N}_]/u.test(adjacent.slice(args.length, args.length + 1));
}

function visibleMentionText(text: string): string {
  let visible = text;
  for (const match of parseMentionLinks(text).toReversed()) {
    visible = `${visible.slice(0, match.start)}${match.attrs.name}${visible.slice(match.end)}`;
  }
  return visible;
}
