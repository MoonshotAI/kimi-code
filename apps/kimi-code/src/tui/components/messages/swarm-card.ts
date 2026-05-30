/**
 * Renders the `Swarm` coordinator dashboard as a dedicated, top-level managed
 * card — a sibling to `ToolCallComponent` hosted by the same streaming-UI
 * managed tool-call lifecycle (one stable component per tool id).
 *
 * Stability invariants (a standalone dashboard component once caused a
 * duplicate-card bug, fixed by folding it into the managed lifecycle; this card
 * preserves the same discipline):
 *   1. Created exactly once per tool id, inside streaming-ui's
 *      `onToolCallStart`, stored in `_pendingToolComponents`. Never re-created.
 *   2. In-place mutation only: `applySwarm` / `setResult` mutate the existing
 *      children (header `setText` + pop-and-rebuild body past the fixed header
 *      index) and call `ui?.requestRender()`. Never re-attached to the
 *      transcript after creation.
 *   3. Byte-stable render: no per-render animation, no spinner / setInterval.
 *      A static `STATUS_BULLET` colored by phase keeps consecutive renders
 *      identical so pi-tui's differential renderer never re-emits the card.
 *   4. The header task is sourced from the live tool-call args, not the
 *      (possibly stale) model task.
 */

import { Container, Text, Spacer } from '@earendil-works/pi-tui';
import type { TUI } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import type { ColorPalette } from '#/tui/theme/colors';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

import type { ManagedToolCard } from './managed-tool-card';
import {
  SWARM_ACTIVITY_MAX_LENGTH,
  formatTokens,
  str,
} from './tool-call-shared';
import {
  applySwarmEvent,
  initialSwarmModel,
  type SwarmEvent,
  type SwarmModel,
  type WorkerRow,
} from './swarm-dashboard-model';

/**
 * Index of the first body child. Children 0/1 are the leading Spacer and the
 * single-line header carried by `headerText`; the swarm body lives past this
 * index and is popped-and-rebuilt in place on every event.
 */
const SWARM_BODY_START_INDEX = 2;

export class SwarmCard extends Container implements ManagedToolCard {
  private toolCall: ToolCallBlockData;
  private result: ToolResultBlockData | undefined;
  private readonly colors: ColorPalette;
  private readonly ui: TUI | undefined;
  private readonly headerText: Text;
  private swarmModel: SwarmModel;

  constructor(
    toolCall: ToolCallBlockData,
    result: ToolResultBlockData | undefined,
    colors: ColorPalette,
    ui?: TUI,
  ) {
    super();
    this.toolCall = toolCall;
    this.result = result;
    this.colors = colors;
    this.ui = ui;
    this.swarmModel = initialSwarmModel(str(toolCall.args['task']));

    this.addChild(new Spacer(1));
    this.headerText = new Text(this.buildSwarmHeader(), 0, 0);
    this.addChild(this.headerText);
    this.buildSwarmBody();

    // A result supplied at construction (replay) finalizes the dashboard the
    // same way a live result would.
    if (result !== undefined) {
      this.finalizeSwarmModelIfNeeded(result);
      this.headerText.setText(this.buildSwarmHeader());
      this.rebuildBody();
    }
  }

  /** True — this card always drives the swarm dashboard. */
  isSwarm(): boolean {
    return true;
  }

  /**
   * Fold a swarm dashboard event into the model and re-render in place. Mirrors
   * `ToolCallComponent`'s prior `applySwarm` so the card stays a single, stable
   * component managed by the normal tool-call lifecycle.
   */
  applySwarm(event: SwarmEvent): void {
    this.swarmModel = applySwarmEvent(this.swarmModel, event);
    this.headerText.setText(this.buildSwarmHeader());
    this.rebuildBody();
    this.ui?.requestRender();
  }

  setResult(result: ToolResultBlockData): void {
    this.result = result;
    this.finalizeSwarmModelIfNeeded(result);
    this.headerText.setText(this.buildSwarmHeader());
    this.rebuildBody();
    this.ui?.requestRender();
  }

  updateToolCall(toolCall: ToolCallBlockData): void {
    this.toolCall = toolCall;
    // The header task is sourced live from the args, so re-sync it.
    this.headerText.setText(this.buildSwarmHeader());
    this.rebuildBody();
    this.ui?.requestRender();
  }

  /** No tool-output body to expand on the swarm card — no-op. */
  setExpanded(_expanded: boolean): void {
    void _expanded;
  }

  /** The swarm card never owns a plan preview. */
  setPlanExpanded(_expanded: boolean): boolean {
    void _expanded;
    return false;
  }

  /** No timers to release — the swarm card uses no per-render animation. */
  dispose(): void {
    // Intentionally empty: stability invariant #3 forbids any timer/spinner.
  }

  // Readonly view for callers that inspect the backing tool call metadata.
  get toolCallView(): Readonly<ToolCallBlockData> {
    return this.toolCall;
  }

  /**
   * Drives the swarm dashboard to its terminal state when the tool result
   * lands. An ordinary failure (planner/synthesizer error) has already driven
   * the model to 'failed' via a progress event carrying the reason, so leave it
   * be; only a genuine abort/cancel reaches an error result still non-terminal,
   * so finalize that as cancelled. A success result ensures the header shows
   * the summary even if the `done` progress event was missed.
   */
  private finalizeSwarmModelIfNeeded(result: ToolResultBlockData): void {
    if (result.is_error === true) {
      if (this.swarmModel.phase !== 'failed') {
        this.swarmModel = applySwarmEvent(this.swarmModel, { t: 'cancelled' });
      }
      return;
    }
    if (this.swarmModel.phase !== 'done' && this.swarmModel.phase !== 'cancelled') {
      this.swarmModel = applySwarmEvent(this.swarmModel, {
        t: 'done',
        succeeded: this.swarmModel.doneCount,
        failed: this.swarmModel.failedCount,
      });
    }
  }

  /**
   * True once live progress arrived (a plan was announced or a worker spawned).
   * False on a card reconstructed from session history: replay restores the
   * tool call + final result but NOT the live tool.progress / subagent.* events
   * that populate the dashboard, so a resumed completed swarm has no worker data.
   */
  private hasLiveData(): boolean {
    return this.swarmModel.total > 0 || this.swarmModel.workers.size > 0;
  }

  /** Pop the body children past the fixed header index and rebuild them. */
  private rebuildBody(): void {
    while (this.children.length > SWARM_BODY_START_INDEX) {
      this.children.pop();
    }
    this.buildSwarmBody();
  }

  // ── Swarm dashboard rendering ────────────────────────────────────
  //
  // The swarm card mirrors `AgentGroupComponent`'s gutter/indent/color
  // vocabulary. No animated, per-render content is used so the rendered lines
  // stay identical across consecutive renders — the property that lets
  // pi-tui's differential renderer keep one stable card.

  /**
   * Single-line header for the Swarm card (carried by `headerText`). Mirrors
   * `AgentGroupComponent.buildHeader`: a status bullet (roleAssistant while
   * active, success when terminal), the bold `Swarm` label, a dim `· title`
   * segment (omitted when empty so no dangling `·`), and a dim phase/summary
   * tail. The displayed task is sourced live from the tool-call args rather
   * than the stale model so it reflects the fully-streamed task string.
   */
  private buildSwarmHeader(): string {
    const c = this.colors;
    const m = this.swarmModel;
    const rawTask = str(this.toolCall.args['task']).replaceAll(/\s+/g, ' ').trim();
    const title = rawTask.length > 56 ? `${rawTask.slice(0, 56)}…` : rawTask;
    const label = chalk.hex(c.primary).bold('Swarm');
    const titlePart = title.length > 0 ? chalk.dim(` · ${title}`) : '';
    const terminal = m.phase === 'done' || m.phase === 'cancelled' || m.phase === 'failed';
    const bullet =
      m.phase === 'failed'
        ? chalk.hex(c.error)(STATUS_BULLET)
        : terminal
          ? chalk.hex(c.success)(STATUS_BULLET)
          : chalk.hex(c.roleAssistant)(STATUS_BULLET);
    let tail: string;
    if (terminal && !this.hasLiveData()) {
      // Resumed from history with no replayed worker data: the worker stats
      // would all be zero and misleading, so show just the phase tag (if any)
      // and let the result body carry the synthesized report.
      tail =
        m.phase === 'cancelled'
          ? chalk.dim(' · cancelled')
          : m.phase === 'failed'
            ? chalk.dim(' · failed')
            : '';
    } else if (terminal) {
      const tag =
        m.phase === 'cancelled' ? ' · cancelled' : m.phase === 'failed' ? ' · failed' : '';
      // Surface drops alongside ✓/✗ so a recovered-with-gaps run is honest about
      // the missing subtasks; omitted when zero to keep the common run compact.
      const droppedPart = m.droppedCount > 0 ? ` ${String(m.droppedCount)}⊘` : '';
      tail = chalk.dim(
        ` · ${String(m.workers.size)} workers · ${String(m.doneCount)}✓ ${String(m.failedCount)}✗${droppedPart}${tag}`,
      );
    } else if (m.phase === 'planning') {
      tail = chalk.dim(' · planning…');
    } else if (m.phase === 'synthesizing') {
      tail = chalk.dim(' · synthesizing…');
    } else {
      tail = chalk.dim(` · ${String(m.doneCount + m.failedCount)}/${String(m.total)} workers`);
    }
    return `${bullet}${label}${titlePart}${tail}`;
  }

  /**
   * Renders one or two gutter lines per worker into the body, mirroring
   * `AgentGroupComponent.appendLines` (the `├─`/`└─`/`│` vocabulary, the
   * 2-space lead, and the dim/primary/error coloring). While still planning
   * with no workers yet, a single dim placeholder line keeps the card from
   * rendering blank.
   */
  private buildSwarmBody(): void {
    const m = this.swarmModel;
    // Resumed-from-history fallback: when no live worker data was replayed, the
    // dashboard would render an empty "0 workers" body and hide the synthesized
    // report. Render the result body (the actual deliverable) instead. A live
    // whole-swarm failure (phase 'failed') is excluded — it already surfaces its
    // reason via the '✗ <reason>' line below.
    if (!this.hasLiveData() && m.phase !== 'failed' && this.result !== undefined) {
      const output = this.result.output.trimEnd();
      if (output.length > 0) {
        for (const line of output.split('\n')) {
          this.addChild(new Text(line, 0, 0));
        }
        return;
      }
    }
    const workers = [...m.workers.values()];
    if (m.phase === 'planning' && workers.length === 0) {
      this.addChild(new Text(`  ${chalk.dim('└─ planning subtasks…')}`, 0, 0));
      return;
    }
    workers.forEach((w, idx) => {
      const isLast = idx === workers.length - 1;
      for (const line of this.buildSwarmWorkerLine(w, isLast)) {
        this.addChild(new Text(line, 0, 0));
      }
    });
    // A whole-swarm failure (planner/synthesizer error) surfaces its reason as
    // an error line so the card is honest about what went wrong instead of
    // hiding the message behind a 'cancelled'-looking header.
    if (m.phase === 'failed') {
      const reason = m.failureMessage ?? 'swarm failed';
      this.addChild(new Text(`  ${chalk.hex(this.colors.error)(`✗ ${reason}`)}`, 0, 0));
    }
  }

  /**
   * Builds the gutter lines for one worker. Line 1 carries the branch, the
   * role, and a dim stats tail; line 2 (omitted once the worker is done)
   * carries the latest activity or the failure reason. Matches
   * `AgentGroupComponent`'s two-line gutter format.
   */
  private buildSwarmWorkerLine(w: WorkerRow, isLast: boolean): string[] {
    const c = this.colors;
    const branch1 = isLast ? '└─' : '├─';
    const branch2 = isLast ? '   ' : '│  ';
    const role = chalk.hex(c.primary)(w.role);

    // Live token counts are shown for every worker (running, retrying, done) so
    // the dashboard stays consistent with `AgentGroupComponent`, which renders
    // live tokens for all subagents from `agent.status.updated`. Running workers
    // get their figure from `worker.tokens`; done workers from `worker.done`.
    const tok = w.tokens !== undefined && w.tokens > 0 ? ` · ${formatTokens(w.tokens)}` : '';
    let statsPart = '';
    if (w.status === 'done') {
      statsPart = chalk.dim(` · ${String(w.toolCount)} call${w.toolCount === 1 ? '' : 's'}${tok}`);
    } else if (w.status === 'retrying') {
      statsPart = chalk.dim(` · retrying…${tok}`);
    } else if (w.status === 'running' && w.toolCount > 0) {
      statsPart = chalk.dim(` · ${String(w.toolCount)} call${w.toolCount === 1 ? '' : 's'}${tok}`);
    }
    const line1 = `  ${branch1} ${role}${statsPart}`;

    if (w.status === 'done') {
      return [line1];
    }
    // Retrying is a transient in-flight state shown as a single line so the
    // role's row stays visible (and stable) while the coordinator re-runs it.
    // Dim the role label to match the 'dropped' convention: non-running rows
    // (retrying, dropped) use a dimmed label, running/done/failed keep primary.
    if (w.status === 'retrying') {
      return [`  ${branch1} ${chalk.dim(w.role)}${statsPart}`];
    }
    if (w.status === 'failed') {
      const errLine = chalk.hex(c.error)(`failed: ${w.error ?? 'error'}`);
      return [line1, `  ${branch2}    ${errLine}`];
    }
    // Dropped: the coordinator gave up on this subtask. Dim the row and show the
    // reason on the second gutter line so the gap is explicit, not silent.
    if (w.status === 'dropped') {
      const dropLine = chalk.dim(`dropped: ${w.error ?? 'no reason'}`);
      return [`  ${branch1} ${chalk.dim(w.role)}`, `  ${branch2}    ${dropLine}`];
    }
    const raw = w.latestActivity ?? 'starting…';
    const activity =
      raw.length > SWARM_ACTIVITY_MAX_LENGTH ? `${raw.slice(0, SWARM_ACTIVITY_MAX_LENGTH)}…` : raw;
    return [line1, `  ${branch2}    ${chalk.dim(`now: ${activity}`)}`];
  }
}
