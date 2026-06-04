import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { SELECT_POINTER } from '#/tui/constant/symbols';
import type {
  GoalQueueMoveDirection,
  GoalQueueSnapshot,
  UpcomingGoal,
} from '#/tui/goal-queue-store';
import type { ColorPalette } from '#/tui/theme/colors';
import { printableChar } from '#/tui/utils/printable-key';
import { SearchableList } from '#/tui/utils/searchable-list';

const MAX_GOAL_OBJECTIVE_LENGTH = 4000;
const ELLIPSIS = '…';
const END_KEY = '\u001B[F';

export type GoalQueueManagerAction =
  | {
      readonly kind: 'move';
      readonly goalId: string;
      readonly direction: GoalQueueMoveDirection;
    }
  | { readonly kind: 'edit'; readonly goalId: string }
  | { readonly kind: 'delete'; readonly goalId: string };

export interface GoalQueueManagerOptions {
  readonly goals: readonly UpcomingGoal[];
  readonly selectedGoalId?: string;
  readonly colors: ColorPalette;
  readonly pageSize?: number;
  readonly onAction: (
    action: GoalQueueManagerAction,
  ) => GoalQueueSnapshot | void | Promise<GoalQueueSnapshot | void>;
  readonly onCancel: () => void;
}

export type GoalQueueEditResult =
  | { readonly kind: 'save'; readonly goalId: string; readonly objective: string }
  | { readonly kind: 'cancel'; readonly goalId: string };

export interface GoalQueueEditDialogOptions {
  readonly goal: UpcomingGoal;
  readonly colors: ColorPalette;
  readonly onDone: (result: GoalQueueEditResult) => void;
}

export class GoalQueueManagerComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: GoalQueueManagerOptions;
  private goals: readonly UpcomingGoal[];
  private list: SearchableList<UpcomingGoal>;
  private movingGoalId: string | undefined;
  private busy = false;

  constructor(opts: GoalQueueManagerOptions) {
    super();
    this.opts = opts;
    this.goals = opts.goals;
    this.list = this.createList(opts.selectedGoalId);
  }

  handleInput(data: string): void {
    if (this.busy) return;
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }

    const selected = this.selectedGoal();
    const decoded = printableChar(data);
    if (matchesKey(data, Key.space) || decoded === ' ') {
      this.movingGoalId = this.movingGoalId === selected?.id ? undefined : selected?.id;
      return;
    }

    if ((decoded === 'e' || decoded === 'E') && selected !== undefined) {
      void this.opts.onAction({ kind: 'edit', goalId: selected.id });
      return;
    }

    if ((decoded === 'd' || decoded === 'D') && selected !== undefined) {
      void this.applyQueueAction({ kind: 'delete', goalId: selected.id });
      return;
    }

    if (this.movingGoalId !== undefined) {
      if (matchesKey(data, Key.up)) {
        void this.applyQueueAction({ kind: 'move', goalId: this.movingGoalId, direction: 'up' });
        return;
      }
      if (matchesKey(data, Key.down)) {
        void this.applyQueueAction({ kind: 'move', goalId: this.movingGoalId, direction: 'down' });
        return;
      }
    }

    if (this.list.handleKey(data)) return;
  }

  override render(width: number): string[] {
    const { colors } = this.opts;
    const view = this.list.view();
    const hint = this.movingGoalId === undefined
      ? '↑↓ navigate · Space select · E edit · D delete · Esc cancel'
      : '↑↓ reorder · Space done · E edit · D delete · Esc cancel';
    const lines: string[] = [
      chalk.hex(colors.primary)('─'.repeat(width)),
      chalk.hex(colors.primary).bold(' Upcoming goals'),
      chalk.hex(colors.textMuted)(` ${hint}`),
      '',
    ];

    if (this.goals.length === 0) {
      lines.push(chalk.hex(colors.textMuted)('  No upcoming goals.'));
    } else {
      for (let i = view.page.start; i < view.page.end; i++) {
        const goal = view.items[i];
        if (goal === undefined) continue;
        lines.push(this.renderGoal(goal, i, i === view.selectedIndex, width));
      }

      const below = view.items.length - view.page.end;
      if (below > 0) {
        lines.push('');
        lines.push(chalk.hex(colors.textMuted)(` ▼ ${String(below)} more`));
      }
    }

    lines.push('');
    lines.push(chalk.hex(colors.primary)('─'.repeat(width)));
    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  private renderGoal(goal: UpcomingGoal, index: number, selected: boolean, width: number): string {
    const { colors } = this.opts;
    const moving = goal.id === this.movingGoalId;
    const pointer = selected ? SELECT_POINTER : ' ';
    const prefix = chalk.hex(selected ? colors.primary : colors.textDim)(`  ${pointer} `);
    const labelPrefix = `${String(index + 1)}. `;
    const stateLabel = moving ? '  selected' : '';
    const labelWidth = visibleWidth(labelPrefix);
    const stateWidth = visibleWidth(stateLabel);
    const objectiveWidth = Math.max(1, width - 5 - labelWidth - stateWidth);
    const objective = truncateToWidth(goal.objective, objectiveWidth, ELLIPSIS);
    const textStyle = selected ? chalk.hex(colors.primary).bold : chalk.hex(colors.text);
    let line = prefix + textStyle(labelPrefix + objective);
    if (moving) line += chalk.hex(colors.success)(stateLabel);
    return line;
  }

  private selectedGoal(): UpcomingGoal | undefined {
    return this.list.selected();
  }

  private async applyQueueAction(action: Exclude<GoalQueueManagerAction, { kind: 'edit' }>) {
    this.busy = true;
    try {
      const result = await this.opts.onAction(action);
      if (result !== undefined) {
        const selectedGoalId = action.kind === 'delete' ? undefined : action.goalId;
        this.goals = result.goals;
        if (!this.goals.some((goal) => goal.id === this.movingGoalId)) {
          this.movingGoalId = undefined;
        }
        this.list = this.createList(selectedGoalId ?? this.movingGoalId);
      }
    } finally {
      this.busy = false;
      this.invalidate();
    }
  }

  private createList(selectedGoalId?: string): SearchableList<UpcomingGoal> {
    const initialIndex = this.goals.findIndex((goal) => goal.id === selectedGoalId);
    return new SearchableList({
      items: this.goals,
      toSearchText: (goal) => goal.objective,
      pageSize: this.opts.pageSize,
      initialIndex: initialIndex === -1 ? 0 : initialIndex,
      searchable: false,
    });
  }
}

export class GoalQueueEditDialogComponent extends Container implements Focusable {
  focused = false;

  private readonly input = new Input();
  private readonly opts: GoalQueueEditDialogOptions;
  private done = false;
  private error: string | undefined;

  constructor(opts: GoalQueueEditDialogOptions) {
    super();
    this.opts = opts;
    this.input.setValue(opts.goal.objective);
    this.input.handleInput(END_KEY);
    this.input.onSubmit = (value) => {
      this.submit(value);
    };
  }

  handleInput(data: string): void {
    if (this.done) return;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c')) ||
      matchesKey(data, Key.ctrl('d'))
    ) {
      this.done = true;
      this.opts.onDone({ kind: 'cancel', goalId: this.opts.goal.id });
      return;
    }
    this.error = undefined;
    this.input.handleInput(data);
  }

  override invalidate(): void {
    super.invalidate();
    this.input.invalidate();
  }

  override render(width: number): string[] {
    this.input.focused = this.focused && !this.done;

    const safeWidth = Math.max(28, width);
    const innerWidth = Math.max(10, safeWidth - 4);
    const pad = '  ';
    const { colors } = this.opts;
    const border = (s: string): string => chalk.hex(colors.primary)(s);
    const title = truncateToWidth(
      chalk.hex(colors.textStrong).bold('Edit upcoming goal'),
      innerWidth,
      ELLIPSIS,
    );
    const subtitle = truncateToWidth(
      chalk.hex(this.error === undefined ? colors.textDim : colors.warning)(
        this.error ?? 'Update the queued objective.',
      ),
      innerWidth,
      ELLIPSIS,
    );
    const inputLine = this.input.render(innerWidth)[0] ?? '> ';
    const footer = truncateToWidth(
      chalk.hex(colors.textDim)('Enter submit · Esc cancel'),
      innerWidth,
      ELLIPSIS,
    );
    const contentLines = [title, '', subtitle, '', inputLine, '', footer];
    const lines = [
      '',
      border('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      border('│') + ' '.repeat(safeWidth - 2) + border('│'),
    ];

    for (const content of contentLines) {
      const rightPad = Math.max(0, innerWidth - visibleWidth(content));
      lines.push(border('│') + pad + content + ' '.repeat(rightPad) + border('│'));
    }

    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    lines.push(border('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines;
  }

  private submit(value: string): void {
    const objective = value.trim();
    if (objective.length === 0) {
      this.error = 'Goal objective cannot be empty.';
      return;
    }
    if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
      this.error = `Goal objective cannot exceed ${MAX_GOAL_OBJECTIVE_LENGTH} characters.`;
      return;
    }
    this.opts.onDone({ kind: 'save', goalId: this.opts.goal.id, objective });
  }
}
