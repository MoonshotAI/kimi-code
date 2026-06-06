export function isUserCancelledSubagentError(error: string): boolean {
  const normalized = error.trim();
  return (
    normalized === 'Aborted by the user' ||
    normalized === 'The user manually interrupted this subagent batch.' ||
    normalized.startsWith('The user manually interrupted this subagent ') ||
    normalized.includes('This was a deliberate user action, not a system error')
  );
}
