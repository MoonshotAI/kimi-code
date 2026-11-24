import type { AppToolCatalogEntry } from '@moonshot-ai/app-core/api';

interface DefaultToolGroupDefinition {
  readonly id: string;
  readonly labelKey: string;
  readonly tools: readonly { name: string; labelKey: string }[];
}

export interface DefaultToolGroup {
  readonly id: string;
  readonly labelKey: string;
  readonly tools: readonly AppToolCatalogEntry[];
}

const DEFAULT_TOOL_GROUPS: readonly DefaultToolGroupDefinition[] = [
  {
    id: 'file',
    labelKey: 'settings.defaultToolsGroupFile',
    tools: [
      { name: 'Read', labelKey: 'settings.defaultToolsLabels.read' },
      { name: 'ReadMediaFile', labelKey: 'settings.defaultToolsLabels.readMediaFile' },
      { name: 'Write', labelKey: 'settings.defaultToolsLabels.write' },
      { name: 'Edit', labelKey: 'settings.defaultToolsLabels.edit' },
      { name: 'Glob', labelKey: 'settings.defaultToolsLabels.glob' },
      { name: 'Grep', labelKey: 'settings.defaultToolsLabels.grep' },
    ],
  },
  {
    id: 'shell',
    labelKey: 'settings.defaultToolsGroupShell',
    tools: [
      { name: 'Bash', labelKey: 'settings.defaultToolsLabels.bash' },
      { name: 'TaskList', labelKey: 'settings.defaultToolsLabels.taskList' },
      { name: 'TaskOutput', labelKey: 'settings.defaultToolsLabels.taskOutput' },
      { name: 'TaskStop', labelKey: 'settings.defaultToolsLabels.taskStop' },
      { name: 'WaitFor', labelKey: 'settings.defaultToolsLabels.waitFor' },
    ],
  },
  {
    id: 'web',
    labelKey: 'settings.defaultToolsGroupWeb',
    tools: [
      { name: 'WebSearch', labelKey: 'settings.defaultToolsLabels.webSearch' },
      { name: 'FetchURL', labelKey: 'settings.defaultToolsLabels.fetchUrl' },
    ],
  },
  {
    id: 'agent',
    labelKey: 'settings.defaultToolsGroupAgent',
    tools: [
      { name: 'TodoList', labelKey: 'settings.defaultToolsLabels.todoList' },
      { name: 'ExitPlanMode', labelKey: 'settings.defaultToolsLabels.exitPlanMode' },
      { name: 'Agent', labelKey: 'settings.defaultToolsLabels.agent' },
      { name: 'AgentSwarm', labelKey: 'settings.defaultToolsLabels.agentSwarm' },
      { name: 'AskUserQuestion', labelKey: 'settings.defaultToolsLabels.askUserQuestion' },
      { name: 'Skill', labelKey: 'settings.defaultToolsLabels.skill' },
      { name: 'NotifyUser', labelKey: 'settings.defaultToolsLabels.notifyUser' },
    ],
  },
  {
    id: 'goal',
    labelKey: 'settings.defaultToolsGroupGoal',
    tools: [
      { name: 'CreateGoal', labelKey: 'settings.defaultToolsLabels.createGoal' },
      { name: 'GetGoal', labelKey: 'settings.defaultToolsLabels.getGoal' },
      { name: 'SetGoalBudget', labelKey: 'settings.defaultToolsLabels.setGoalBudget' },
      { name: 'UpdateGoal', labelKey: 'settings.defaultToolsLabels.updateGoal' },
    ],
  },
  {
    id: 'cron',
    labelKey: 'settings.defaultToolsGroupCron',
    tools: [
      { name: 'CronCreate', labelKey: 'settings.defaultToolsLabels.cronCreate' },
      { name: 'CronList', labelKey: 'settings.defaultToolsLabels.cronList' },
      { name: 'CronDelete', labelKey: 'settings.defaultToolsLabels.cronDelete' },
    ],
  },
  {
    id: 'tower',
    labelKey: 'settings.defaultToolsGroupTower',
    tools: [
      { name: 'TowerInit', labelKey: 'settings.defaultToolsLabels.towerInit' },
      { name: 'TowerPlan', labelKey: 'settings.defaultToolsLabels.towerPlan' },
      { name: 'TowerSpawn', labelKey: 'settings.defaultToolsLabels.towerSpawn' },
      { name: 'TowerMerge', labelKey: 'settings.defaultToolsLabels.towerMerge' },
      { name: 'TowerRebase', labelKey: 'settings.defaultToolsLabels.towerRebase' },
      { name: 'TowerTeardown', labelKey: 'settings.defaultToolsLabels.towerTeardown' },
      { name: 'TowerComplete', labelKey: 'settings.defaultToolsLabels.towerComplete' },
      { name: 'TowerSend', labelKey: 'settings.defaultToolsLabels.towerSend' },
      { name: 'TowerInbox', labelKey: 'settings.defaultToolsLabels.towerInbox' },
      { name: 'TowerFinding', labelKey: 'settings.defaultToolsLabels.towerFinding' },
      { name: 'TowerReview', labelKey: 'settings.defaultToolsLabels.towerReview' },
      { name: 'TowerMission', labelKey: 'settings.defaultToolsLabels.towerMission' },
      { name: 'TowerStatus', labelKey: 'settings.defaultToolsLabels.towerStatus' },
    ],
  },
];

const TOOL_LABEL_KEYS = new Map<string, string>(
  DEFAULT_TOOL_GROUPS.flatMap((group) =>
    group.tools.map((tool) => [tool.name, tool.labelKey] as const),
  ),
);

export function defaultToolLabelKey(name: string): string | undefined {
  return TOOL_LABEL_KEYS.get(name);
}

export function groupDefaultTools(entries: readonly AppToolCatalogEntry[]): DefaultToolGroup[] {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const groups: DefaultToolGroup[] = [];
  for (const group of DEFAULT_TOOL_GROUPS) {
    const tools = group.tools
      .map((tool) => byName.get(tool.name))
      .filter((entry): entry is AppToolCatalogEntry => entry !== undefined);
    if (tools.length > 0) groups.push({ id: group.id, labelKey: group.labelKey, tools });
  }
  const other = entries.filter((entry) => !TOOL_LABEL_KEYS.has(entry.name));
  if (other.length > 0) {
    groups.push({ id: 'other', labelKey: 'settings.defaultToolsGroupOther', tools: other });
  }
  return groups;
}
