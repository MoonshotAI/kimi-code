import type {
  ContextMessage,
  PermissionMode,
  AgentConfigUpdateData,
  TokenUsage,
  WireEntry,
} from './agent-record-types';

export interface ProjectedMessage {
  lineNo: number;
  time?: number;
  source: 'append_message' | 'compaction_summary';
  message: ContextMessage;
  toolStepUuids: string[];
}

export interface UsageTotals {
  byScope: { session: TokenUsage; turn: TokenUsage };
  byModel: Record<string, TokenUsage>;
}

export interface ConfigSnapshot {
  cwd?: string;
  modelAlias?: string;
  profileName?: string;
  thinkingLevel?: string;
  systemPrompt?: string;
}

export interface ContextProjection {
  messages: ProjectedMessage[];
  usage: UsageTotals;
  config: ConfigSnapshot;
  permission: { mode: PermissionMode | null };
  planMode: { active: boolean; id?: string };
}

const ZERO: TokenUsage = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };

export function projectContext(entries: ReadonlyArray<WireEntry>): ContextProjection {
  let messages: ProjectedMessage[] = [];
  const usage: UsageTotals = {
    byScope: { session: { ...ZERO }, turn: { ...ZERO } },
    byModel: {},
  };
  const config: ConfigSnapshot = {};
  let permissionMode: PermissionMode | null = null;
  let planActive = false;
  let planId: string | undefined;

  for (const entry of entries) {
    const rec = entry.data;
    switch (rec.type) {
      case 'context.append_message':
        messages.push({
          lineNo: entry.lineNo,
          time: rec.time,
          source: 'append_message',
          message: rec.message,
          toolStepUuids: [],
        });
        break;
      case 'context.clear':
        messages = [];
        break;
      case 'context.apply_compaction':
        messages = [{
          lineNo: entry.lineNo,
          time: rec.time,
          source: 'compaction_summary',
          message: {
            role: 'system',
            content: [{ type: 'text', text: rec.summary }],
            toolCalls: [],
          } as ContextMessage,
          toolStepUuids: [],
        }];
        break;
      case 'usage.record': {
        const scope = rec.usageScope ?? 'session';
        addUsage(usage.byScope[scope], rec.usage);
        if (!usage.byModel[rec.model]) usage.byModel[rec.model] = { ...ZERO };
        addUsage(usage.byModel[rec.model]!, rec.usage);
        break;
      }
      case 'config.update': {
        const upd = rec as AgentConfigUpdateData & { type: 'config.update' };
        if (upd.cwd !== undefined) config.cwd = upd.cwd;
        if (upd.modelAlias !== undefined) config.modelAlias = upd.modelAlias;
        if (upd.profileName !== undefined) config.profileName = upd.profileName;
        if (upd.thinkingLevel !== undefined) config.thinkingLevel = upd.thinkingLevel;
        if (upd.systemPrompt !== undefined) config.systemPrompt = upd.systemPrompt;
        break;
      }
      case 'permission.set_mode':
        permissionMode = rec.mode;
        break;
      case 'plan_mode.enter':
        planActive = true; planId = rec.id; break;
      case 'plan_mode.cancel':
      case 'plan_mode.exit':
        planActive = false; planId = undefined; break;
      default:
        break;
    }
  }

  return {
    messages,
    usage,
    config,
    permission: { mode: permissionMode },
    planMode: { active: planActive, id: planId },
  };
}

function addUsage(into: TokenUsage, src: TokenUsage): void {
  (into as any).inputOther += src.inputOther;
  (into as any).output += src.output;
  (into as any).inputCacheRead += src.inputCacheRead;
  (into as any).inputCacheCreation += src.inputCacheCreation;
}
