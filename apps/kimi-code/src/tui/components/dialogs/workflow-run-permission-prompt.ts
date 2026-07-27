import type { WorkflowSummary } from '@moonshot-ai/kimi-code-sdk';

import {
  StartPermissionPromptComponent,
  type StartPermissionOption,
} from './start-permission-prompt';

export type WorkflowRunPermissionChoice = 'run' | 'view' | 'cancel';

export interface WorkflowRunPermissionPromptOptions {
  readonly workflow: WorkflowSummary;
  readonly args: string;
  readonly onSelect: (choice: WorkflowRunPermissionChoice) => void;
  readonly onCancel: () => void;
}

const OPTIONS: readonly StartPermissionOption<WorkflowRunPermissionChoice>[] = [
  {
    value: 'run',
    label: 'Run workflow',
    description: 'Start the workflow in the background. Track progress with /workflow runs or /tasks.',
  },
  {
    value: 'view',
    label: 'View script',
    description: 'Inspect the full workflow script before deciding.',
  },
  {
    value: 'cancel',
    label: 'Do not run',
    description: 'Return to the input box without starting anything.',
  },
];

function noticeLines(workflow: WorkflowSummary, args: string): string[] {
  const lines = [
    workflow.description,
    `Phases: ${workflow.phases.map((phase, index) => `${String(index + 1)}. ${phase.title}${phase.detail !== undefined ? ` — ${phase.detail}` : ''}`).join('  ·  ')}`,
    'Runs multiple subagents in parallel — token usage can be significantly higher than a normal session. Bounded by workflow limits (see the [workflows] config section).',
  ];
  const hint = (workflow as { argumentHint?: string }).argumentHint;
  if (args.length > 0) {
    lines.push(`Args: ${args}`);
  } else if (hint !== undefined && hint.length > 0) {
    lines.push(`Arguments: ${hint}`);
  }
  if (workflow.source !== 'builtin') lines.push(`Source: ${workflow.source} (${workflow.path})`);
  return lines;
}

export class WorkflowRunPermissionPromptComponent extends StartPermissionPromptComponent<WorkflowRunPermissionChoice> {
  constructor(opts: WorkflowRunPermissionPromptOptions) {
    super({
      title: `Run workflow "${opts.workflow.name}"?`,
      noticeLines: noticeLines(opts.workflow, opts.args),
      options: OPTIONS,
      onSelect: opts.onSelect,
      onCancel: opts.onCancel,
    });
  }
}
