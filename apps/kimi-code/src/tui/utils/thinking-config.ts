import type { ModelAlias, ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';

export function isThinkingOn(effort: ThinkingEffort): boolean {
  return effort !== 'off';
}

export function thinkingEffortToConfig(
  effort: ThinkingEffort,
  model?: Pick<ModelAlias, 'supportEfforts' | 'defaultEffort'>,
): {
  enabled: boolean;
  effort?: string;
} {
  if (effort === 'off') return { enabled: false };
  if (effort === 'on') return { enabled: true };
  const efforts = model?.supportEfforts;
  if (efforts !== undefined && efforts.includes(effort)) {
    const declared = model?.defaultEffort;
    const ceiling =
      declared !== undefined && efforts.includes(declared)
        ? efforts.indexOf(declared)
        : efforts.length - 2;
    if (efforts.indexOf(effort) > ceiling) return { enabled: true };
  }
  return { enabled: true, effort };
}

export function thinkingEffortFromConfig(
  config: { enabled?: boolean; effort?: string } | undefined,
): ThinkingEffort | undefined {
  if (config?.enabled === false) return 'off';
  return config?.effort;
}
