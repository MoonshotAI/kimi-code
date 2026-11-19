import type {
  ClientMetadata,
  ModelRequest,
  ProtocolName,
  RequestState,
  RequestView,
  ScriptedStep,
  ViewRole,
} from '#/model/types';
import { firstUserText, remindersSinceReply, textsOf, userTextsSinceReply } from '#/model/view';

export interface RequestFacts {
  readonly protocol: ProtocolName;
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly authorization?: string;
  readonly rawBody: string;
  readonly body: unknown;
  readonly view: RequestView;
  readonly metadata?: ClientMetadata;
  readonly tools: readonly string[];
  readonly firstUserText: string;
  readonly userTextsSinceReply: readonly string[];
  readonly remindersSinceReply: readonly string[];
  texts(role: ViewRole): readonly string[];
}

export interface IncomingFacts {
  readonly protocol: ProtocolName;
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string;
  readonly body: unknown;
  readonly view: RequestView;
}

export function factsOf(incoming: IncomingFacts): RequestFacts {
  const messages = incoming.view.messages;
  return {
    ...incoming,
    authorization: incoming.headers['authorization'],
    metadata: parseMetadata(incoming.headers['x-msh-client-metadata']),
    tools: incoming.view.tools.map((tool) => tool.name),
    firstUserText: firstUserText(messages),
    userTextsSinceReply: userTextsSinceReply(messages),
    remindersSinceReply: remindersSinceReply(messages),
    texts: (role) => textsOf(messages, role),
  };
}

export class RecordedRequest implements ModelRequest {
  private currentStep: ScriptedStep | null = null;
  private currentState: RequestState = 'pending';

  constructor(
    readonly index: number,
    readonly lane: string,
    readonly laneIndex: number,
    private readonly facts: RequestFacts,
    private readonly onStateChange: () => void,
  ) {}

  get protocol(): ProtocolName {
    return this.facts.protocol;
  }

  get method(): string {
    return this.facts.method;
  }

  get path(): string {
    return this.facts.path;
  }

  get headers(): Readonly<Record<string, string>> {
    return this.facts.headers;
  }

  get authorization(): string | undefined {
    return this.facts.authorization;
  }

  get rawBody(): string {
    return this.facts.rawBody;
  }

  get body(): unknown {
    return this.facts.body;
  }

  get view(): RequestView {
    return this.facts.view;
  }

  get metadata(): ClientMetadata | undefined {
    return this.facts.metadata;
  }

  get tools(): readonly string[] {
    return this.facts.tools;
  }

  get firstUserText(): string {
    return this.facts.firstUserText;
  }

  get userTextsSinceReply(): readonly string[] {
    return this.facts.userTextsSinceReply;
  }

  get remindersSinceReply(): readonly string[] {
    return this.facts.remindersSinceReply;
  }

  get step(): ScriptedStep | null {
    return this.currentStep;
  }

  get state(): RequestState {
    return this.currentState;
  }

  texts(role: ViewRole): readonly string[] {
    return this.facts.texts(role);
  }

  playing(step: ScriptedStep): void {
    this.currentStep = step;
  }

  transition(state: RequestState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.onStateChange();
  }

  get settled(): boolean {
    return this.currentState === 'finished' || this.currentState === 'aborted' || this.currentState === 'cut' || this.currentState === 'failed';
  }
}

function parseMetadata(header: string | undefined): ClientMetadata | undefined {
  if (header === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(header);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  return {
    agentRole: stringField(record, 'agent_role'),
    turnTrigger: stringField(record, 'turn_trigger'),
    stepReason: stringField(record, 'step_reason'),
    userInputId: stringField(record, 'user_input_id'),
    parentRequestId: stringField(record, 'parent_request_id'),
  };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}
