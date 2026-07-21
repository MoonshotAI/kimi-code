/**
 * Pure helpers for composing session labels in the session picker.
 *
 * Detection rule for the `[imported]` badge: `metadata.imported_from_kimi_cli`
 * is strictly the boolean `true`. This mirrors the value written by
 * `migration-legacy` into the session's `state.json` `custom` block.
 */

import { t } from '#/i18n';

export function formatImportedBadge(): string {
  return t('tui.migration.badgeImported');
}

export interface SessionLabelInput {
  readonly title: string;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export function isImportedSession(
  metadata: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (metadata === undefined) return false;
  return metadata[IMPORTED_FLAG_KEY] === true;
}

export function formatSessionLabel(input: SessionLabelInput): string {
  const prefix = isImportedSession(input.metadata) ? `${formatImportedBadge()} ` : '';
  return `${prefix}${input.title}`;
}

const IMPORTED_FLAG_KEY = 'imported_from_kimi_cli';
