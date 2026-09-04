export const TODO_ENTITY_ID = 'todo';

export const DURABLE_SYSTEM_SUBTYPES = [
  'compaction',
  'undo',
  'clear',
  'goal',
  'plan.enter',
  'plan.exit',
  'plan.revision',
  'swarm.enter',
  'swarm.exit',
  'skill',
  'interruption',
] as const;

export type DurableSystemSubtype = (typeof DURABLE_SYSTEM_SUBTYPES)[number];

export const LIVE_ONLY_SYSTEM_SUBTYPES = ['hook', 'notice'] as const;

export type LiveOnlySystemSubtype = (typeof LIVE_ONLY_SYSTEM_SUBTYPES)[number];

export function turnIdOf(ordinal: number): string {
  return `t${ordinal}`;
}

export function stepIdOf(turnId: string, ordinal: number): string {
  return `${turnId}.${ordinal}`;
}

export function textMessageIdOf(stepId: string, ordinal: number): string {
  return `${stepId}.a${ordinal}`;
}

export function stepUserMessageIdOf(stepId: string, ordinal: number): string {
  return `${stepId}.u${ordinal}`;
}

export function turnUserMessageIdOf(turnId: string): string {
  return `${turnId}.u0`;
}

export function attachmentIdOf(baseId: string, ordinal: number): string {
  return `${baseId}.att${ordinal}`;
}

export function turnOrdinalOf(turnId: string): number | undefined {
  if (!/^t\d+$/.test(turnId)) return undefined;
  return Number(turnId.slice(1));
}

export function stepRefOf(stepId: string): { turnId: string; ordinal: number } | undefined {
  const match = /^(t\d+)\.(\d+)$/.exec(stepId);
  if (match === null) return undefined;
  return { turnId: match[1]!, ordinal: Number(match[2]) };
}

export function systemIdOf(subtype: string, ordinal: number): string {
  return `sys_${subtype}_${ordinal}`;
}

export function isCompactionSystemId(id: string): boolean {
  return id.startsWith(`sys_compaction_`);
}

export function isUndoAnchorOrigin(origin: unknown): boolean {
  const kind = (origin as { kind?: unknown } | null | undefined)?.kind;
  if (kind === undefined || kind === 'user') return true;
  const trigger = (origin as { trigger?: unknown } | null | undefined)?.trigger;
  return (kind === 'skill_activation' || kind === 'plugin_command') && trigger === 'user-slash';
}

export function isVisibleTurnOrigin(origin: unknown): boolean {
  const kind = (origin as { kind?: unknown } | null | undefined)?.kind;
  if (kind === 'system_trigger') {
    const name = (origin as { name?: unknown } | null | undefined)?.name;
    return name === 'goal_continuation' || name === 'subagent';
  }
  if (kind === 'skill_activation' || kind === 'plugin_command') {
    return (origin as { trigger?: unknown } | null | undefined)?.trigger === 'user-slash';
  }
  if (kind === 'injection' || kind === 'retry' || kind === 'compaction_summary') return false;
  return true;
}

export class SystemIdAllocator {
  private readonly seqs = new Map<string, number>();

  next(subtype: string): string {
    const ordinal = (this.seqs.get(subtype) ?? 0) + 1;
    this.seqs.set(subtype, ordinal);
    return systemIdOf(subtype, ordinal);
  }

  seed(subtype: string, ordinal: number): void {
    this.seqs.set(subtype, Math.max(this.seqs.get(subtype) ?? 0, ordinal));
  }

  counts(): ReadonlyMap<string, number> {
    return this.seqs;
  }
}
