export function notifyResultState(output: unknown): 'displayed' | 'suppressed' | undefined {
  if (output === 'Update shown to the user.') return 'displayed';
  if (output === 'Notifications are disabled; the update was not displayed.') return 'suppressed';
  return undefined;
}
