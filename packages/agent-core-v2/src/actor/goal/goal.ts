export interface GoalReasonInput {
  readonly reason?: string;
}

export interface ResumeGoalInput extends GoalReasonInput {
  readonly continueIfPaused?: boolean;
  readonly continueIfBlocked?: boolean;
}

