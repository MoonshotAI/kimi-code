export type ProtocolName = 'openai' | 'anthropic' | 'google';

export type FinishReason = 'completed' | 'tool_calls' | 'truncated' | 'filtered' | 'paused';

export type FinishSpec = FinishReason | { readonly raw: string } | null;

export interface UsageSpec {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

export interface ToolCallSpec {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly id?: string;
  readonly rawArguments?: string;
  readonly argumentChunks?: number;
  readonly invalid?: boolean;
}

export type ReplyPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'think'; readonly text: string; readonly signature?: string }
  | { readonly type: 'call'; readonly call: ToolCallSpec };

export interface ErrorSpec {
  readonly status: number;
  readonly message: string;
  readonly type?: string;
  readonly code?: string | number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface Timing {
  readonly delayMs?: number;
  readonly intervalMs?: number;
}

export interface HoldPoint {
  readonly name: string;
  readonly beforeUnit: number;
}

export type ReplyEnding =
  | { readonly type: 'complete' }
  | { readonly type: 'stream-error'; readonly error: ErrorSpec }
  | { readonly type: 'disconnect' };

interface StepBase {
  readonly label: string;
  readonly timing: Timing;
  readonly hold?: HoldPoint;
}

export interface ReplyStep extends StepBase {
  readonly kind: 'reply';
  readonly parts: readonly ReplyPart[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly finish?: FinishSpec;
  readonly usage?: UsageSpec | null;
  readonly ending: ReplyEnding;
  readonly interleaveCalls: boolean;
}

export interface ErrorStep extends StepBase {
  readonly kind: 'error';
  readonly error: ErrorSpec;
}

export interface RawStep extends StepBase {
  readonly kind: 'raw';
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly chunks: readonly string[];
}

export interface NetworkErrorStep extends StepBase {
  readonly kind: 'network-error';
}

export type ScriptedStep = ReplyStep | ErrorStep | RawStep | NetworkErrorStep;

export interface StepContext {
  readonly lane: string;
  readonly call: number;
  readonly signal: AbortSignal;
}

export type StepFactory = (request: ModelRequest, context: StepContext) => ScriptedStep | Promise<ScriptedStep>;

export type Step = ScriptedStep | StepFactory;

export type ViewRole = 'system' | 'user' | 'assistant' | 'tool';

export type ViewPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly url: string; readonly mediaType?: string }
  | { readonly type: 'video'; readonly url: string; readonly mediaType?: string }
  | { readonly type: 'other'; readonly raw: unknown };

export interface ViewCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ViewMessage {
  readonly role: ViewRole;
  readonly text: string;
  readonly parts: readonly ViewPart[];
  readonly calls: readonly ViewCall[];
  readonly callId?: string;
  readonly reasoning?: string;
}

export interface ViewTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
}

export interface RequestView {
  readonly model?: string;
  readonly stream: boolean;
  readonly system: string;
  readonly tools: readonly ViewTool[];
  readonly messages: readonly ViewMessage[];
}

export interface ClientMetadata {
  readonly agentRole?: string;
  readonly turnTrigger?: string;
  readonly stepReason?: string;
  readonly userInputId?: string;
  readonly parentRequestId?: string;
}

export type RequestState = 'pending' | 'streaming' | 'held' | 'finished' | 'aborted' | 'cut' | 'failed';

export interface ModelRequest {
  readonly index: number;
  readonly lane: string;
  readonly laneIndex: number;
  readonly protocol: ProtocolName;
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly authorization?: string;
  readonly rawBody: string;
  readonly body: unknown;
  readonly view: RequestView;
  readonly metadata?: ClientMetadata;
  readonly step: ScriptedStep | null;
  readonly state: RequestState;
  readonly tools: readonly string[];
  readonly firstUserText: string;
  readonly userTextsSinceReply: readonly string[];
  readonly remindersSinceReply: readonly string[];
  texts(role: ViewRole): readonly string[];
}

export type UnscriptedPolicy = 'fail' | 'hang' | { readonly reply: Step };

export interface WaitOptions {
  readonly timeoutMs?: number;
}
