import { isKimiError, resolveErrorTitle } from '#/cli/sdk-errors';
import { chalkStderr } from 'chalk';

import { STARTUP_ERROR_COLOR } from '#/constant/startup-error';
import { t } from '#/i18n';

export interface StartupErrorFormatOptions {
  readonly errorStyle?: (text: string) => string;
  readonly operation?: string;
}

function formatUnknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatStartupError(
  error: unknown,
  options: StartupErrorFormatOptions = {},
): string {
  const errorStyle = options.errorStyle ?? chalkStderr.hex(STARTUP_ERROR_COLOR);

  if (!isKimiError(error)) {
    const operation = options.operation ?? t('startup.operations.startShell');
    return `${errorStyle(
      t('startup.error.failedTo', {
        operation,
        message: formatUnknownErrorMessage(error),
      }),
    )}\n`;
  }

  const lines = [
    errorStyle(t('startup.error.title', { title: resolveErrorTitle(error.code) })),
    '',
    errorStyle(t('startup.error.messageLabel')),
    errorStyle(error.message),
  ];

  return `${lines.join('\n')}\n`;
}
