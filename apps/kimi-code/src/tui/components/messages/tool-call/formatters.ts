/**
 * Pure formatting helpers extracted from tool-call.ts.
 *
 * These functions have no state and no UI side effects — they belong
 * outside the component class per the project's coding conventions.
 */

import { isAbsolute, relative, sep } from 'node:path';

import type { TokenUsage } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

import type { FinishedSubCall, OngoingSubCall } from './types';

const MAX_ARG_LENGTH = 60;
const PATH_KEYS = new Set(['path', 'file_path']);

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function backgroundFailureMessage(
  status: 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost' | undefined,
): string | undefined {
  switch (status) {
    case 'lost':
      return t('tui.messages.toolCall.backgroundLost');
    case 'killed':
      return t('tui.messages.toolCall.backgroundKilled');
    case 'timed_out':
      return t('tui.messages.toolCall.backgroundTimedOut');
    case 'failed':
      return t('tui.messages.toolCall.backgroundFailed');
    case 'completed':
    case undefined:
      return undefined;
  }
}

export function formatSubagentContextTokens(contextTokens: number | undefined): string | undefined {
  if (contextTokens === undefined || contextTokens <= 0) return undefined;
  const formatted = contextTokens >= 1000 ? `${(contextTokens / 1000).toFixed(1)}k` : String(contextTokens);
  return t('tui.messages.toolCall.tokenCount', { count: formatted });
}

export function usageInputTotal(usage: TokenUsage): number {
  return (usage.inputOther ?? 0) + (usage.inputCacheRead ?? 0) + (usage.inputCacheCreation ?? 0);
}

export function usageTotal(usage: TokenUsage | undefined): number {
  if (usage === undefined) return 0;
  return usageInputTotal(usage) + usage.output;
}

export function formatSubagentTokens(usage: TokenUsage | undefined): string | undefined {
  const total = usageTotal(usage);
  if (total <= 0) return undefined;
  const formatted = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
  return t('tui.messages.toolCall.tokenCount', { count: formatted });
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return t('tui.messages.toolCall.byteSizeB', { count: bytes });
  if (bytes < 1024 * 1024) return t('tui.messages.toolCall.byteSizeKB', { count: (bytes / 1024).toFixed(1) });
  return t('tui.messages.toolCall.byteSizeMB', { count: (bytes / 1024 / 1024).toFixed(1) });
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return t('tui.messages.toolCall.elapsedSeconds', { count: seconds });
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return t('tui.messages.toolCall.elapsedMinutes', { minutes, seconds: remainder });
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return t('tui.messages.toolCall.tokenCount', { count: (n / 1_000_000).toFixed(1) });
  if (n >= 1_000) return t('tui.messages.toolCall.tokenCount', { count: (n / 1_000).toFixed(1) });
  return t('tui.messages.toolCall.tokenCount', { count: n });
}

export function truncateArgValue(key: string, value: string): string {
  if (value.length <= MAX_ARG_LENGTH) return value;
  if (PATH_KEYS.has(key)) {
    return '…' + value.slice(value.length - (MAX_ARG_LENGTH - 1));
  }
  return value.slice(0, MAX_ARG_LENGTH - 3) + '...';
}

export function makeWorkspaceRelativePath(filePath: string, workspaceDir: string | undefined): string {
  if (workspaceDir === undefined || workspaceDir.length === 0 || !isAbsolute(filePath)) {
    return filePath;
  }
  const relativePath = relative(workspaceDir, filePath);
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return filePath;
  }
  return relativePath;
}

export function formatKeyArgument(
  toolName: string,
  key: string,
  value: string,
  workspaceDir: string | undefined,
): string {
  const displayValue =
    toolName === 'Read' && PATH_KEYS.has(key)
      ? makeWorkspaceRelativePath(value, workspaceDir)
      : value;
  return truncateArgValue(key, displayValue);
}

export function extractKeyArgument(
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir?: string,
): string | null {
  const keyMap: Record<string, string[]> = {
    Bash: ['command'],
    Read: ['path', 'file_path'],
    Write: ['path', 'file_path'],
    Edit: ['path', 'file_path'],
    Grep: ['pattern'],
    Glob: ['pattern'],
    FetchURL: ['url'],
    WebSearch: ['query'],
    Agent: ['description', 'prompt'],
  };

  if (toolName === 'Glob') {
    const pattern = args['pattern'];
    if (typeof pattern !== 'string' || pattern.length === 0) return null;
    let summary = pattern;
    const path = args['path'];
    if (typeof path === 'string' && path.length > 0) {
      summary += ` · ${makeWorkspaceRelativePath(path, workspaceDir)}`;
    }
    if (args['include_ignored'] === true) {
      summary += ` · ${t('tui.messages.toolCall.includeIgnored')}`;
    }
    return truncateArgValue('pattern', summary);
  }

  const candidates = keyMap[toolName] ?? Object.keys(args);
  for (const key of candidates) {
    const val = args[key];
    if (typeof val === 'string' && val.length > 0) {
      const firstLine = val.split('\n')[0] ?? val;
      const displayValue =
        toolName === 'Bash' && val.includes('\n') ? `${firstLine}…` : firstLine;
      return formatKeyArgument(toolName, key, displayValue, workspaceDir);
    }
  }
  return null;
}

export function formatSubagentLabel(agentName: string | undefined): string {
  const raw = agentName?.trim();
  if (raw === undefined || raw.length === 0) return t('tui.messages.toolCall.subAgentDefault');
  const label = raw
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  if (/\bagent$/i.test(label)) return label;
  return `${label} ${t('tui.messages.toolCall.subAgentSuffix')}`;
}

export function tailNonEmptyLines(text: string, maxLines: number): string[] {
  if (text.length === 0) return [];
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-maxLines);
}

/**
 * Computes the "latest activity" line for group rows:
 *   1. latest ongoing sub-tool (`Using {name} ({keyArg})`)
 *   2. latest finished sub-tool (`Used {name} ({keyArg})`)
 *   3. last non-empty line from accumulated subagent text
 */
export function computeLatestActivity(
  ongoing: ReadonlyMap<string, OngoingSubCall>,
  finished: readonly FinishedSubCall[],
  text: string,
  workspaceDir?: string,
): string | undefined {
  if (ongoing.size > 0) {
    const lastOngoing = [...ongoing.values()].at(-1);
    if (lastOngoing !== undefined) {
      return formatActivityLine(
        translateActivityVerb('Using'),
        lastOngoing.name,
        lastOngoing.args,
        workspaceDir,
      );
    }
  }
  if (finished.length > 0) {
    const last = finished.at(-1);
    if (last !== undefined) {
      return formatActivityLine(translateActivityVerb('Used'), last.name, last.args, workspaceDir);
    }
  }
  if (text.length > 0) {
    const tail = text
      .split('\n')
      .toReversed()
      .find((l) => l.trim().length > 0);
    if (tail !== undefined) return tail.trim();
  }
  return undefined;
}

function formatActivityLine(
  verb: string,
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir?: string,
): string {
  const keyArg = extractKeyArgument(toolName, args, workspaceDir);
  return keyArg ? `${verb} ${toolName} (${keyArg})` : `${verb} ${toolName}`;
}

function translateActivityVerb(verb: 'Using' | 'Used'): string {
  return verb === 'Using'
    ? t('tui.messages.toolCall.using')
    : t('tui.messages.toolCall.used');
}
