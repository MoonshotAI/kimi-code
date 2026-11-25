import { ErrorCodes } from '@moonshot-ai/kimi-code-sdk';

export function isGitBashMissingError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === ErrorCodes.SHELL_GIT_BASH_NOT_FOUND
  );
}
