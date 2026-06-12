import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import type {
  ReviewEventAssignment,
  ReviewEventComment,
  ReviewEventProgress,
} from '@moonshot-ai/kimi-code-sdk';

import type { ColorPalette } from '#/tui/theme/colors';
import {
  SwarmProgressComponent,
  type SwarmProgressCellLabel,
  type SwarmProgressLegendItem,
  type SwarmProgressMemberRenderInput,
  type SwarmProgressOptions,
} from './swarm-progress';

const REVIEW_SWARM_METADATA_KEY = 'review_swarm';
const REVIEW_STATUS_BAR_CHAR = '━';

export interface ReviewSwarmProgressOptions {
  readonly description: string;
  readonly args: Record<string, unknown>;
  readonly requestRender?: () => void;
  readonly availableGridHeight?: () => number | undefined;
}

export interface ReviewSwarmMetadata {
  readonly perspectives: readonly string[];
  readonly fileGroups: readonly ReviewSwarmFileGroup[];
  readonly items: readonly ReviewSwarmItem[];
}

interface ReviewSwarmFileGroup {
  readonly id: string;
  readonly name: string;
  readonly files: readonly string[];
}

interface ReviewSwarmItem {
  readonly index: number;
  readonly perspective: string;
  readonly fileGroupId: string;
  readonly fileGroupName: string;
  readonly assignedFiles: readonly string[];
}

interface ReviewSwarmRuntimeState {
  readonly metadata: ReviewSwarmMetadata;
  readonly assignmentIndexById: Map<string, number>;
  readonly latestCommentByIndex: Map<number, string>;
  readonly progressByIndex: Map<number, ReviewEventProgress>;
}

export class ReviewSwarmProgressComponent implements Component {
  private readonly state: ReviewSwarmRuntimeState;
  private readonly panel: SwarmProgressComponent;

  constructor(options: ReviewSwarmProgressOptions) {
    const metadata = reviewSwarmMetadataFromArgs(options.args);
    const state: ReviewSwarmRuntimeState = {
      metadata,
      assignmentIndexById: new Map(),
      latestCommentByIndex: new Map(),
      progressByIndex: new Map(),
    };
    const panelOptions: SwarmProgressOptions = {
      title: 'Agent Swarm',
      description: options.description,
      legend: reviewSwarmLegend(metadata),
      statusLabels: { working: 'Reviewing...' },
      formatMemberId: ({ index }) => reviewSwarmMemberId(metadata, index),
      cellLabel: (input) => reviewSwarmCellLabel(state, input),
      footerBar: ({ width, colors }) => renderReviewFooterBar(state, width, colors),
      requestRender: options.requestRender,
      availableGridHeight: options.availableGridHeight,
    };
    this.state = state;
    this.panel = new SwarmProgressComponent(panelOptions);
    this.panel.setMemberCount(metadata.items.length);
    this.panel.setMemberItemTexts(metadata.items.map(reviewSwarmItemLabel));
    this.panel.markItemsStarted();
    this.panel.markInputComplete();
  }

  dispose(): void {
    this.panel.dispose();
  }

  invalidate(): void {
    this.panel.invalidate();
  }

  render(width: number): string[] {
    return this.panel.render(width);
  }

  setActivitySpinnerText(provider: (() => string) | undefined): void {
    this.panel.setActivitySpinnerText(provider);
  }

  markToolCallEnded(): void {
    this.panel.markToolCallEnded();
  }

  isToolCallActive(): boolean {
    return this.panel.isToolCallActive();
  }

  isRequestStreaming(): boolean {
    return this.panel.isRequestStreaming();
  }

  updateArgs(args: Record<string, unknown>): void {
    void args;
  }

  registerSubagent(input: {
    readonly agentId: string;
    readonly swarmIndex?: number;
    readonly description?: string | undefined;
  }): void {
    this.panel.registerSubagent(input);
  }

  markStarted(agentId: string): void {
    this.panel.markStarted(agentId);
  }

  recordToolCall(input: {
    readonly agentId: string;
    readonly toolCallId: string;
  }): void {
    this.panel.recordToolCall(input);
  }

  appendModelDelta(input: {
    readonly agentId: string;
    readonly delta: string;
  }): void {
    this.panel.appendModelDelta(input);
  }

  markCompleted(agentId: string, completedText?: string): void {
    this.panel.markCompleted(agentId, completedText);
  }

  markSuspended(input: {
    readonly agentId: string;
    readonly reason: string;
    readonly swarmIndex?: number;
    readonly description?: string | undefined;
  }): void {
    this.panel.markSuspended(input);
  }

  markFailed(agentId: string, failureText?: string): void {
    this.panel.markFailed(agentId, failureText);
  }

  markSwarmFailed(failureText?: string): void {
    this.panel.markSwarmFailed(failureText);
  }

  markCancelled(agentId: string): void {
    this.panel.markCancelled(agentId);
  }

  markActiveCancelled(): void {
    this.panel.markActiveCancelled();
  }

  applyResult(output: string): boolean {
    return this.panel.applyResult(output);
  }

  handleAssignmentStarted(assignment: ReviewEventAssignment): void {
    if (assignment.role !== 'reviewer') return;
    const index = findReviewItemIndex(this.state.metadata, assignment);
    if (index === undefined) return;
    this.state.assignmentIndexById.set(assignment.id, index);
  }

  handleAssignmentProgress(progress: ReviewEventProgress): void {
    const index = this.state.assignmentIndexById.get(progress.assignmentId);
    if (index === undefined) return;
    this.state.progressByIndex.set(index, progress);
    if (progress.status === 'complete') {
      this.panel.markMemberCompleted(index, progress.summary);
    } else if (progress.status === 'blocked') {
      this.panel.markMemberFailed(index, progress.blocker ?? progress.summary);
    }
  }

  handleCommentAdded(comment: ReviewEventComment): void {
    if (comment.assignmentId === undefined) return;
    const index = this.state.assignmentIndexById.get(comment.assignmentId);
    if (index === undefined) return;
    this.state.latestCommentByIndex.set(
      index,
      `${comment.severity}: ${comment.path}:${String(comment.line)} ${comment.title}`,
    );
  }
}

export function reviewSwarmMetadataFromArgs(args: Record<string, unknown>): ReviewSwarmMetadata {
  const metadata = args[REVIEW_SWARM_METADATA_KEY];
  if (isReviewSwarmMetadata(metadata)) return metadata;
  const items = Array.isArray(args['items']) ? args['items'].map(String) : [];
  return {
    perspectives: [],
    fileGroups: [],
    items: items.map((item, index) => ({
      index: index + 1,
      perspective: '',
      fileGroupId: `item-${String(index + 1)}`,
      fileGroupName: item,
      assignedFiles: [],
    })),
  };
}

function reviewSwarmLegend(metadata: ReviewSwarmMetadata): readonly SwarmProgressLegendItem[] {
  return metadata.perspectives.map((perspective, index) => ({
    label: `${perspectiveLetter(index)} ${perspective}`,
  }));
}

function reviewSwarmMemberId(metadata: ReviewSwarmMetadata, index: number): string {
  const item = metadata.items[index - 1];
  if (item === undefined) return String(index).padStart(3, '0');
  const perspectiveIndex = metadata.perspectives.indexOf(item.perspective);
  const groupIndex = metadata.fileGroups.findIndex((group) => group.id === item.fileGroupId);
  const perspective = perspectiveLetter(Math.max(0, perspectiveIndex));
  const groupNumber = Math.max(1, groupIndex + 1);
  return `${perspective}-${String(groupNumber).padStart(2, '0')}`;
}

function reviewSwarmItemLabel(item: ReviewSwarmItem): string {
  return `${item.fileGroupName} / ${item.perspective}`;
}

function reviewSwarmCellLabel(
  state: ReviewSwarmRuntimeState,
  input: SwarmProgressMemberRenderInput,
): SwarmProgressCellLabel | undefined {
  const latestComment = state.latestCommentByIndex.get(input.index);
  if (latestComment !== undefined) {
    return { text: latestComment };
  }
  const progress = Array.from(state.progressByIndex.values())
    .find((entry) => state.assignmentIndexById.get(entry.assignmentId) === input.index);
  if (progress?.summary !== undefined) return { text: progress.summary };
  if (progress?.blocker !== undefined) return { text: progress.blocker };
  return undefined;
}

function renderReviewFooterBar(
  state: ReviewSwarmRuntimeState,
  width: number,
  colors: ColorPalette,
): string {
  const totalFiles = reviewSwarmFiles(state.metadata).length;
  const reviewedFiles = reviewedReviewSwarmFiles(state).length;
  const failedFiles = failedReviewSwarmFiles(state).length;
  const countText = `${String(reviewedFiles)}/${String(totalFiles)} files`;
  const count = chalk.hex(colors.textDim)(countText);
  const gap = ' ';
  const barWidth = Math.max(1, width - visibleWidth(countText) - visibleWidth(gap));
  const completedWidth = totalFiles === 0
    ? 0
    : Math.round(barWidth * reviewedFiles / totalFiles);
  const failedWidth = totalFiles === 0
    ? 0
    : Math.round(barWidth * failedFiles / totalFiles);
  const remainingWidth = Math.max(0, barWidth - completedWidth - failedWidth);
  const bar =
    chalk.hex(colors.success)(REVIEW_STATUS_BAR_CHAR.repeat(completedWidth)) +
    chalk.hex(colors.error)(REVIEW_STATUS_BAR_CHAR.repeat(failedWidth)) +
    chalk.hex(colors.textMuted)(REVIEW_STATUS_BAR_CHAR.repeat(remainingWidth));
  return truncateToWidth(`${count}${gap}${bar}`, width);
}

function reviewedReviewSwarmFiles(state: ReviewSwarmRuntimeState): readonly string[] {
  return reviewSwarmFiles(state.metadata).filter((file) => {
    const assignments = state.metadata.items.filter((item) => item.assignedFiles.includes(file));
    if (assignments.length === 0) return false;
    return assignments.every((item) => {
      const assignmentId = assignmentIdForItemIndex(state, item.index);
      return assignmentId !== undefined &&
        state.progressByIndex.get(item.index)?.status === 'complete';
    });
  });
}

function failedReviewSwarmFiles(state: ReviewSwarmRuntimeState): readonly string[] {
  const reviewed = new Set(reviewedReviewSwarmFiles(state));
  return reviewSwarmFiles(state.metadata).filter((file) => {
    if (reviewed.has(file)) return false;
    const assignments = state.metadata.items.filter((item) => item.assignedFiles.includes(file));
    return assignments.some((item) => state.progressByIndex.get(item.index)?.status === 'blocked');
  });
}

function assignmentIdForItemIndex(
  state: ReviewSwarmRuntimeState,
  itemIndex: number,
): string | undefined {
  for (const [assignmentId, index] of state.assignmentIndexById) {
    if (index === itemIndex) return assignmentId;
  }
  return undefined;
}

function reviewSwarmFiles(metadata: ReviewSwarmMetadata): readonly string[] {
  return [...new Set(metadata.fileGroups.flatMap((group) => group.files))];
}

function findReviewItemIndex(
  metadata: ReviewSwarmMetadata,
  assignment: ReviewEventAssignment,
): number | undefined {
  return metadata.items.find((item) =>
    item.perspective === assignment.perspective &&
    item.fileGroupId === assignment.group &&
    sameStringSet(item.assignedFiles, assignment.assignedFiles)
  )?.index;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
}

function perspectiveLetter(index: number): string {
  let value = Math.max(0, Math.floor(index));
  let label = '';
  do {
    label = String.fromCharCode(65 + value % 26) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return label;
}

function isReviewSwarmMetadata(value: unknown): value is ReviewSwarmMetadata {
  if (!isRecord(value)) return false;
  return Array.isArray(value['perspectives']) &&
    Array.isArray(value['fileGroups']) &&
    Array.isArray(value['items']);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
