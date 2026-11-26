import { computed } from 'vue';
import { num, str } from './toolArgs';
import { useToolCard, useToolCardExpansion, type ToolCardProps } from './useToolCard';

export type { ToolCardProps } from './useToolCard';

const GOAL_STATUS_KEYS: Record<string, string> = {
  active: 'status.goalStatusActive',
  blocked: 'status.goalStatusBlocked',
  complete: 'status.goalStatusComplete',
};

const GOAL_BUDGET_UNITS = ['turns', 'tokens', 'milliseconds', 'seconds', 'minutes', 'hours'];

type Translate = (key: string, params?: Record<string, unknown>) => string;

export const GOAL_TOOL_KIND = {
  create: 'creategoal',
  update: 'updategoal',
  budget: 'setgoalbudget',
} as const;

export function goalHeadline(kind: string, args: Record<string, unknown> | null, t: Translate): string {
  switch (kind) {
    case GOAL_TOOL_KIND.create:
      return str(args?.objective) ?? '';
    case GOAL_TOOL_KIND.update: {
      const status = str(args?.status) ?? '';
      const key = GOAL_STATUS_KEYS[status];
      return key ? t(key) : status;
    }
    case GOAL_TOOL_KIND.budget: {
      const value = num(args?.value);
      const unit = str(args?.unit);
      if (value === undefined || !unit) return '';
      return GOAL_BUDGET_UNITS.includes(unit)
        ? t(`tools.goal.${unit}`, { value })
        : t('tools.goal.budget', { value, unit });
    }
    default:
      return '';
  }
}

export function updateGoalVisibleOutput(lines: readonly string[]): string[] {
  const blank = lines.findIndex((line) => line.trim() === '');
  return blank > 0 ? lines.slice(0, blank) : [...lines];
}

export function goalVisibleOutput(lines: readonly string[], kind: string): string[] {
  return kind === GOAL_TOOL_KIND.update ? updateGoalVisibleOutput(lines) : [...lines];
}

export function useGoalToolCard(props: ToolCardProps) {
  const card = useToolCard(props);
  const { t, kind, args, hasOutput } = card;
  const objective = computed(() => str(args.value?.objective) ?? '');
  const criterion = computed(() => str(args.value?.completionCriterion) ?? str(args.value?.completion_criterion) ?? '');
  const headline = computed(() => goalHeadline(kind.value, args.value, t));
  const visibleOutput = computed(() => goalVisibleOutput(props.tool.output ?? [], kind.value));
  const hasDetail = computed(() => Boolean(criterion.value) || (kind.value === GOAL_TOOL_KIND.create && hasOutput.value));
  const canExpand = computed(() => hasDetail.value || hasOutput.value);
  const { open } = useToolCardExpansion(props, canExpand);
  return { ...card, objective, criterion, headline, visibleOutput, hasDetail, canExpand, open };
}
