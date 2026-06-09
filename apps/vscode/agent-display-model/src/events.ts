import type {
  DisplayApprovalPart,
  DisplayAvailableCommand,
  DisplayBlock,
  DisplayCompactionTrigger,
  DisplayErrorModel,
  DisplayMediaPart,
  DisplayPart,
  DisplayPlanViewModel,
  DisplayRole,
  DisplayStatusViewModel,
  DisplayTokenUsage,
} from './model';

export type DisplayEvent =
  | { type: 'conversation.reset' }
  | { type: 'message.begin'; id?: string; role: DisplayRole; text?: string }
  | { type: 'turn.begin'; userText: string; parts?: DisplayPart[] }
  | { type: 'turn.complete' }
  | { type: 'turn.error'; error: DisplayErrorModel }
  | { type: 'turn.interrupted'; reason?: string; message?: string }
  | { type: 'step.begin'; n: number }
  | { type: 'content.append'; kind: 'text' | 'thinking'; text: string }
  | { type: 'content.append'; kind: 'media'; media: DisplayMediaPart }
  | {
      type: 'tool.call';
      id: string;
      name: string;
      argumentsText?: string | null;
      status?: 'pending' | 'running';
    }
  | { type: 'tool.call.delta'; id: string; argumentsPart: string }
  | {
      type: 'tool.result';
      id: string;
      isError?: boolean;
      output?: string;
      message?: string;
      displayBlocks?: DisplayBlock[];
    }
  | { type: 'plan.replace'; plan: DisplayPlanViewModel }
  | { type: 'approval.request'; request: DisplayApprovalPart }
  | { type: 'approval.resolved'; requestId: string | number }
  | { type: 'approval.clear' }
  | { type: 'status.update'; status: DisplayStatusViewModel }
  | { type: 'usage.add'; usage: DisplayTokenUsage }
  | { type: 'compaction.begin'; trigger?: DisplayCompactionTrigger; instruction?: string; message?: string }
  | {
      type: 'compaction.end';
      status?: 'completed' | 'cancelled' | 'blocked';
      trigger?: DisplayCompactionTrigger;
      instruction?: string;
      summary?: string;
      compactedCount?: number;
      tokensBefore?: number;
      tokensAfter?: number;
      message?: string;
    }
  | { type: 'step.interrupted'; reason?: string; message?: string }
  | { type: 'available_commands.update'; commands: DisplayAvailableCommand[] }
  | {
      type: 'subagent.event';
      parentToolCallId: string;
      event: DisplayEvent;
    };
