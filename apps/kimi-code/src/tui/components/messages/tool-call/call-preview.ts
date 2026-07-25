/**
 * Call preview builders — render the "what is this tool about to do"
 * section of a ToolCallComponent.
 *
 * Extracted from ToolCallComponent to isolate the per-tool preview
 * renderers (Write/Edit/Bash + streaming + ExitPlanMode plan box).
 *
 * Functions are pure: they take a context object and return a list of
 * `Component` instances instead of mutating the parent container.
 */

import { Text, type Component, type MarkdownTheme } from '@moonshot-ai/pi-tui';
import { highlightLines, langFromPath } from '#/tui/components/media/code-highlight';
import { renderDiffLinesClustered } from '#/tui/components/media/diff-preview';
import { COMMAND_PREVIEW_LINES } from '#/tui/constant/rendering';
import { STREAMING_ARGS_PREVIEW_MAX_CHARS } from '#/tui/constant/streaming';
import { currentTheme } from '#/tui/theme';
import { t } from '#/i18n';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

import { PlanBoxComponent } from '../plan-box';
import { ShellExecutionComponent } from '../shell-execution';
import {
  extractApprovedPlan,
  interpretExitPlanModeOutcome,
  isExitPlanModeOutcomeOutput,
} from './plan-mode';
import { formatByteSize, formatElapsed, str } from './formatters';
import { extractPartialStringField } from './streaming-preview';

/** Inputs needed to render the call preview block. */
export interface CallPreviewContext {
  readonly toolCall: ToolCallBlockData;
  readonly result: ToolResultBlockData | undefined;
  readonly expanded: boolean;
  readonly markdownTheme: MarkdownTheme;
  /** Inline plan override captured from runtime events. */
  readonly currentPlan?: string;
  /** Plan path override captured from runtime events. */
  readonly planPath?: string;
}

/**
 * Build the call preview section.
 *
 * Dispatches to:
 *   - ExitPlanMode -> plan box preview
 *   - truncated args -> truncated marker
 *   - streaming args -> streaming preview (Write/Edit/Bash)
 *   - Write -> highlighted source preview
 *   - Edit -> diff preview
 *   - Bash -> shell execution preview
 *
 * Tools without a dedicated preview produce an empty list.
 */
export function buildCallPreview(ctx: CallPreviewContext): Component[] {
  const { toolCall, result, expanded, markdownTheme } = ctx;
  const name = toolCall.name;

  if (name === 'ExitPlanMode') {
    return buildPlanPreview(ctx);
  }

  if (result === undefined && toolCall.truncated === true) {
    return [
      new Text(
        currentTheme.dim(t('tui.messages.toolCall.argumentsTruncated')),
        2, 0,
      ),
    ];
  }

  if (result === undefined && toolCall.streamingArguments !== undefined) {
    return buildStreamingPreview(toolCall.streamingArguments, toolCall, expanded);
  }

  const shouldCap = !expanded;
  if (name === 'Write') {
    return buildWritePreview(toolCall, shouldCap);
  }
  if (name === 'Edit') {
    return buildEditPreview(toolCall, shouldCap);
  }
  if (name === 'Bash') {
    return buildBashPreview(toolCall, expanded);
  }
  return [];
}

// ── Write preview ──

function buildWritePreview(toolCall: ToolCallBlockData, shouldCap: boolean): Component[] {
  const content = str(toolCall.args['content']);
  if (content.length === 0) return [];
  const filePath = str(toolCall.args['file_path'] ?? toolCall.args['path']);
  const lang = langFromPath(filePath);
  const allLines = highlightLines(content, lang);
  const shown = shouldCap ? allLines.slice(0, COMMAND_PREVIEW_LINES) : allLines;
  const remaining = allLines.length - shown.length;
  const components: Component[] = [];
  for (const [i, line] of shown.entries()) {
    const lineNum = currentTheme.dim(String(i + 1).padStart(4) + '  ');
    components.push(new Text(lineNum + line, 2, 0));
  }
  if (shouldCap && remaining > 0) {
    components.push(
      new Text(
        currentTheme.dim(
          t('tui.messages.toolCall.moreLinesHint', {
            remaining,
            total: allLines.length,
          }),
        ),
        2, 0,
      ),
    );
  }
  return components;
}

// ── Edit preview ──

function buildEditPreview(toolCall: ToolCallBlockData, shouldCap: boolean): Component[] {
  const oldStr = str(toolCall.args['old_string']);
  const newStr = str(toolCall.args['new_string']);
  if (oldStr.length === 0 && newStr.length === 0) return [];
  const filePath = str(toolCall.args['file_path'] ?? toolCall.args['path']);
  const lines = renderDiffLinesClustered(oldStr, newStr, filePath, {
    contextLines: 3,
    ...(shouldCap ? { maxLines: COMMAND_PREVIEW_LINES } : {}),
  });
  return lines.map((line) => new Text(line, 2, 0));
}

// ── Bash preview ──

function buildBashPreview(toolCall: ToolCallBlockData, expanded: boolean): Component[] {
  const command = str(toolCall.args['command']);
  if (command.length === 0) return [];
  return [
    new ShellExecutionComponent({
      command,
      showCommand: true,
      commandPreviewLines: expanded ? undefined : COMMAND_PREVIEW_LINES,
    }),
  ];
}

// ── Streaming preview ──

function buildStreamingPreview(
  streamText: string,
  toolCall: ToolCallBlockData,
  expanded: boolean,
): Component[] {
  const name = toolCall.name;
  const previewText = streamText.slice(0, STREAMING_ARGS_PREVIEW_MAX_CHARS);

  if (name === 'Write') {
    return buildStreamingWritePreview(previewText);
  }
  if (name === 'Edit') {
    return buildStreamingEditPreview(previewText, toolCall);
  }
  if (name === 'Bash') {
    return buildStreamingBashPreview(previewText, expanded);
  }
  return [];
}

function buildStreamingWritePreview(previewText: string): Component[] {
  const content = extractPartialStringField(previewText, 'content');
  if (content === undefined || content.length === 0) return [];
  const filePath =
    extractPartialStringField(previewText, 'file_path') ??
    extractPartialStringField(previewText, 'path') ??
    '';
  const lang = langFromPath(filePath);
  const allLines = highlightLines(content, lang);
  const maxLines = COMMAND_PREVIEW_LINES;
  const scrollLines =
    allLines.length > maxLines ? allLines.slice(allLines.length - maxLines) : allLines;
  const components: Component[] = [];
  for (const [i, line] of scrollLines.entries()) {
    const originalLineNumber =
      allLines.length > maxLines ? allLines.length - maxLines + i : i;
    const lineNum = currentTheme.dim(String(originalLineNumber + 1).padStart(4) + '  ');
    components.push(new Text(lineNum + line, 2, 0));
  }
  return components;
}

function buildStreamingEditPreview(
  previewText: string,
  toolCall: ToolCallBlockData,
): Component[] {
  const filePath =
    extractPartialStringField(previewText, 'file_path') ??
    extractPartialStringField(previewText, 'path') ??
    '';
  const bytes = Buffer.byteLength(previewText, 'utf8');
  const startedAtMs = toolCall.streamingStartedAtMs;
  const elapsedSeconds =
    startedAtMs === undefined ? 0 : Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  const target =
    filePath.length > 0
      ? t('tui.messages.toolCall.preparingChangesTarget', { filePath })
      : '';
  const progress = t('tui.messages.toolCall.preparingChanges', {
    target,
    size: formatByteSize(bytes),
    elapsed: formatElapsed(elapsedSeconds),
  });
  return [new Text(currentTheme.dim(progress), 2, 0)];
}

function buildStreamingBashPreview(previewText: string, expanded: boolean): Component[] {
  const cmd = extractPartialStringField(previewText, 'command');
  if (cmd === undefined || cmd.length === 0) return [];
  return [
    new ShellExecutionComponent({
      command: cmd,
      showCommand: true,
      commandPreviewLines: expanded ? undefined : COMMAND_PREVIEW_LINES,
    }),
  ];
}

// ── Plan preview (ExitPlanMode) ──

function buildPlanPreview(ctx: CallPreviewContext): Component[] {
  const plan = resolvePlanForPreview(ctx);
  if (plan.length === 0) return [];
  const path = resolvePlanPath(ctx);
  return [
    new PlanBoxComponent(plan, ctx.markdownTheme, currentTheme.color('success'), path, {
      status: resolvePlanBoxStatus(ctx),
    }),
  ];
}

function resolvePlanForPreview(ctx: CallPreviewContext): string {
  const inlinePlan = str(ctx.toolCall.args['plan']);
  if (inlinePlan.length > 0) return inlinePlan;
  if (ctx.result !== undefined && !ctx.result.is_error) {
    const approved = extractApprovedPlan(ctx.result.output);
    if (approved.length > 0) return approved;
  }
  return ctx.currentPlan ?? '';
}

function resolvePlanPath(ctx: CallPreviewContext): string | undefined {
  if (ctx.result !== undefined && !ctx.result.is_error) {
    const fromResult = interpretExitPlanModeOutcome(ctx.result.output).path;
    if (fromResult !== undefined && fromResult.length > 0) return fromResult;
  }
  return ctx.planPath;
}

function resolvePlanBoxStatus(
  ctx: CallPreviewContext,
): { label: string; colorHex: string } | undefined {
  const result = ctx.result;
  if (ctx.toolCall.name !== 'ExitPlanMode' || result === undefined) return undefined;
  if (!isExitPlanModeOutcomeOutput(result.output)) return undefined;
  const outcome = interpretExitPlanModeOutcome(result.output);
  if (outcome.kind !== 'rejected') return undefined;
  return { label: t('tui.messages.toolCall.rejected'), colorHex: currentTheme.color('error') };
}
