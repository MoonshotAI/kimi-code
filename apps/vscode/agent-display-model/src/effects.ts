import type { DisplayApprovalPart, DisplayAvailableCommand, DisplayStatusViewModel } from './model';

export type DisplayEffect =
  | { type: 'TrackFiles'; paths: string[] }
  | { type: 'ClearTrackedFiles' }
  | { type: 'OpenApproval'; request: DisplayApprovalPart }
  | { type: 'ClearApprovals' }
  | { type: 'UpdateStatus'; status: DisplayStatusViewModel | null }
  | { type: 'UpdateAvailableCommands'; commands: DisplayAvailableCommand[] }
  | { type: 'Notify'; level: 'info' | 'warning' | 'error'; message: string };
