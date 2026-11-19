import { FakeModelClosedError, FakeModelVerificationError, TestkitError } from '#/errors';
import { TIMEOUTS } from '#/fixtures/timeouts';
import { deferred } from '#/fixtures/wait';
import { callProblems, messageProblems } from '#/model/checks';
import { resolveUsage } from '#/model/emission';
import { createFetchTransport } from '#/model/fetch-transport';
import { HoldRegistry, type Hold } from '#/model/holds';
import { serveHttp, type HttpEndpoint } from '#/model/http-transport';
import { builtInLaneOf, LaneState, type Lane, type LaneMatcher } from '#/model/lanes';
import { play, type Playback, type PlaybackSink } from '#/model/playback';
import type { EncodeContext, ProtocolCodec } from '#/model/protocols/codec';
import { codecForPath } from '#/model/protocols/registry';
import { factsOf, RecordedRequest, type RequestFacts } from '#/model/record';
import { held, say } from '#/model/steps';
import type { IncomingRequest } from '#/model/transport';
import type { ErrorSpec, ModelRequest, ScriptedStep, Step, WaitOptions } from '#/model/types';
import { waitForModelEvent } from '#/model/wait';

export interface FakeModelOptions {
  readonly apiKey?: string;
  readonly models?: readonly string[];
  readonly intervalMs?: number;
  readonly checkMessages?: boolean;
  readonly checkCalls?: boolean;
  readonly sideReply?: string;
}

export type RequestTarget = number | ((request: ModelRequest) => boolean);

export interface FakeModel {
  readonly fetch: typeof fetch;
  readonly origin: string;
  readonly baseUrl: string;
  listen(): Promise<string>;
  script(...steps: readonly Step[]): Lane;
  scriptFor(firstUserTextIncludes: string, ...steps: readonly Step[]): Lane;
  lane(name: string): Lane;
  route(name: string, match: LaneMatcher): Lane;
  hold(name: string): Hold;
  requests(lane?: string): readonly ModelRequest[];
  request(index: number): ModelRequest;
  waitForRequest(target: RequestTarget, options?: WaitOptions): Promise<ModelRequest>;
  heldTurns(): number;
  waitForHeldTurn(options?: WaitOptions): Promise<void>;
  releaseHeld(): void;
  callId(requestIndex: number, callIndex: number): string;
  problems(): readonly string[];
  verify(): void;
  close(): Promise<void>;
}

export function createFakeModel(options: FakeModelOptions = {}): FakeModel {
  return new FakeModelImpl(options);
}

export async function startFakeModel(options: FakeModelOptions = {}): Promise<FakeModel> {
  const model = createFakeModel(options);
  await model.listen();
  return model;
}

const DEFAULT_MODELS = ['testkit-model'];

class FakeModelImpl implements FakeModel {
  readonly fetch: typeof fetch;
  private readonly closing = new AbortController();
  private readonly holds = new HoldRegistry(this.closing.signal);
  private readonly builtIn = new Map<string, LaneState>();
  private readonly routes: LaneState[] = [];
  private readonly records: RecordedRequest[] = [];
  private readonly recordedProblems: string[] = [];
  private readonly arrivalListeners = new Set<() => void>();
  private readonly stateListeners = new Set<() => void>();
  private readonly activeSinks = new Set<PlaybackSink>();
  private endpoint: HttpEndpoint | undefined;
  private starting: Promise<HttpEndpoint> | undefined;

  constructor(private readonly options: FakeModelOptions) {
    const onScripted = (step: Step): void => this.claimHold(step);
    const closing = this.closing.signal;
    this.builtIn.set('main', new LaneState('main', 'fail', onScripted, closing));
    this.builtIn.set('subagent', new LaneState('subagent', 'fail', onScripted, closing));
    this.builtIn.set('compaction', new LaneState('compaction', 'fail', onScripted, closing));
    this.builtIn.set('side', new LaneState('side', { reply: say(options.sideReply ?? 'OK') }, onScripted, closing));
    this.fetch = createFetchTransport((incoming, sink) => this.handle(incoming, sink));
  }

  get origin(): string {
    if (this.endpoint === undefined) {
      throw new TestkitError('The fake model is not listening; call listen() or create it with startFakeModel()');
    }
    return this.endpoint.origin;
  }

  get baseUrl(): string {
    return `${this.origin}/v1`;
  }

  async listen(): Promise<string> {
    if (this.closing.signal.aborted) throw new FakeModelClosedError();
    this.starting ??= serveHttp((incoming, sink) => this.handle(incoming, sink));
    this.endpoint = await this.starting;
    return this.baseUrl;
  }

  script(...steps: readonly Step[]): Lane {
    return this.lane('main').script(...steps);
  }

  scriptFor(firstUserTextIncludes: string, ...steps: readonly Step[]): Lane {
    const name = `first user text includes ${JSON.stringify(firstUserTextIncludes)}`;
    const existing = this.routes.find((route) => route.name === name);
    const lane = existing ?? this.route(name, (request) => request.firstUserText.includes(firstUserTextIncludes));
    return lane.script(...steps);
  }

  lane(name: string): Lane {
    const lane = this.builtIn.get(name) ?? this.routes.find((route) => route.name === name);
    if (lane === undefined) {
      const known = [...this.builtIn.keys(), ...this.routes.map((route) => route.name)];
      throw new TestkitError(`Unknown lane ${JSON.stringify(name)}; known lanes: ${known.join(', ')}`);
    }
    return lane;
  }

  route(name: string, match: LaneMatcher): Lane {
    if (this.builtIn.has(name) || this.routes.some((route) => route.name === name)) {
      throw new TestkitError(`A lane named ${JSON.stringify(name)} already exists`);
    }
    const lane = new LaneState(name, 'fail', (step) => this.claimHold(step), this.closing.signal, match);
    this.routes.push(lane);
    return lane;
  }

  hold(name: string): Hold {
    return this.holds.handle(name);
  }

  requests(lane?: string): readonly ModelRequest[] {
    return lane === undefined ? this.records : this.records.filter((request) => request.lane === lane);
  }

  request(index: number): ModelRequest {
    const request = this.records[index];
    if (request === undefined) {
      throw new TestkitError(`The fake model has received ${this.records.length} request(s); request ${index} does not exist`);
    }
    return request;
  }

  waitForRequest(target: RequestTarget, options: WaitOptions = {}): Promise<ModelRequest> {
    const find = (): ModelRequest | undefined =>
      typeof target === 'number' ? this.records[target] : this.records.find((request) => target(request));
    const existing = find();
    if (existing !== undefined) return Promise.resolve(existing);
    return this.waitFor<ModelRequest>((settle) => {
      const request = find();
      if (request !== undefined) settle(request);
    }, options, () => typeof target === 'number' ? `request ${target}` : 'a request matching the predicate');
  }

  heldTurns(): number {
    return this.records.filter((request) => request.state === 'held').length;
  }

  waitForHeldTurn(options: WaitOptions = {}): Promise<void> {
    if (this.heldTurns() > 0) return Promise.resolve();
    return this.waitFor<void>((settle) => {
      if (this.heldTurns() > 0) settle();
    }, options, () => 'a held turn');
  }

  releaseHeld(): void {
    this.holds.releaseReached();
  }

  callId(requestIndex: number, callIndex: number): string {
    return `call_${requestIndex}_${callIndex}`;
  }

  problems(): readonly string[] {
    return [...this.recordedProblems];
  }

  verify(): void {
    const problems = [...this.recordedProblems];
    for (const lane of [...this.builtIn.values(), ...this.routes]) {
      const remaining = lane.remaining();
      if (remaining.length === 0) continue;
      problems.push(`lane ${JSON.stringify(lane.name)} has ${remaining.length} unused step(s): ${remaining.map(describeStep).join(', ')}`);
    }
    for (const { name, request } of this.holds.unsettled()) {
      problems.push(`hold ${JSON.stringify(name)} was reached by request #${request.index} but never released, failed, or cut`);
    }
    if (problems.length > 0) throw new FakeModelVerificationError(problems);
  }

  async close(): Promise<void> {
    if (this.closing.signal.aborted) return;
    this.closing.abort();
    for (const sink of this.activeSinks) sink.disconnect();
    if (this.starting === undefined) return;
    const endpoint = await this.starting;
    await endpoint.close();
  }

  private async handle(incoming: IncomingRequest, sink: PlaybackSink): Promise<void> {
    if (this.closing.signal.aborted) {
      sink.resetConnection();
      return;
    }
    this.activeSinks.add(sink);
    try {
      await this.dispatch(incoming, sink);
    } finally {
      this.activeSinks.delete(sink);
    }
  }

  private async dispatch(incoming: IncomingRequest, sink: PlaybackSink): Promise<void> {
    const path = incoming.path.split('?')[0] ?? incoming.path;
    if (incoming.method === 'GET' && path.endsWith('/models')) {
      this.respondModels(incoming, sink);
      return;
    }
    const codec = codecForPath(path);
    if (codec === undefined) {
      this.problem(`unexpected request ${incoming.method} ${incoming.path}`);
      respondPlain(sink, 404, { error: { message: `testkit fake model has no endpoint ${incoming.method} ${path}`, type: 'not_found' } });
      return;
    }
    if (!this.authorized(incoming)) {
      this.problem(`request ${incoming.method} ${incoming.path} used the wrong API key`);
      respondEncoded(sink, codec, { status: 401, message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(incoming.body);
    } catch {
      this.problem(`request ${incoming.method} ${incoming.path} has a body that is not JSON`);
      respondEncoded(sink, codec, { status: 400, message: 'testkit fake model expects a JSON body', type: 'invalid_request_error' });
      return;
    }
    const view = codec.parseRequest(body, path);
    const facts = factsOf({
      protocol: codec.name,
      method: incoming.method,
      path: incoming.path,
      headers: incoming.headers,
      rawBody: incoming.body,
      body,
      view,
    });
    let lane: LaneState;
    try {
      lane = this.classify(facts);
    } catch (error) {
      this.problem(`could not route ${incoming.method} ${incoming.path} (first user text ${JSON.stringify(facts.firstUserText)}): ${messageOf(error)}`);
      respondEncoded(sink, codec, { status: 400, message: 'testkit could not route this request', type: 'testkit_error' });
      return;
    }
    const record = new RecordedRequest(this.records.length, lane.name, lane.nextIndex, facts, () => this.notify(this.stateListeners));
    this.records.push(record);
    lane.record(record);
    this.notify(this.arrivalListeners);
    if (this.options.checkMessages !== false) {
      for (const problem of messageProblems(view.messages)) this.problem(`request #${record.index} (${lane.name}): ${problem}`);
    }
    const step = await this.resolveStep(lane, record, codec, sink);
    if (step === undefined) return;
    if (step.kind === 'reply' && this.options.checkCalls !== false) {
      for (const problem of callProblems(step, record.view.tools)) this.problem(`request #${record.index} (${lane.name}): ${problem}`);
    }
    record.playing(step);
    try {
      await play(step, this.playbackOf(step, record, codec, sink));
    } catch (error) {
      this.problem(`request #${record.index} could not play ${step.label}: ${describeError(error)}`);
      record.transition('failed');
      throw error;
    }
    if (sink.gone && !record.settled) record.transition('aborted');
  }

  private async resolveStep(lane: LaneState, record: RecordedRequest, codec: ProtocolCodec, sink: PlaybackSink): Promise<ScriptedStep | undefined> {
    const next = lane.take();
    if (next !== undefined) return this.materialize(next, lane, record, codec, sink);
    const policy = lane.unscriptedPolicy;
    if (policy === 'fail') {
      this.problem(`request #${record.index} on lane ${JSON.stringify(lane.name)} had no scripted step (first user text: ${JSON.stringify(record.firstUserText)})`);
      respondEncoded(sink, codec, {
        status: 400,
        message: `testkit fake model has no scripted step for request #${record.index} on lane ${JSON.stringify(lane.name)}`,
        type: 'invalid_request_error',
      });
      record.transition('failed');
      return undefined;
    }
    if (policy === 'hang') {
      const name = `unscripted request #${record.index}`;
      this.holds.automatic(name);
      return held(name, say('Working on it'), 1);
    }
    return this.materialize(policy.reply, lane, record, codec, sink);
  }

  private async materialize(
    step: Step,
    lane: LaneState,
    record: RecordedRequest,
    codec: ProtocolCodec,
    sink: PlaybackSink,
  ): Promise<ScriptedStep | undefined> {
    if (typeof step !== 'function') return step;
    const signal = sink.goneSignal;
    const cancelled = deferred<undefined>();
    const onAbort = (): void => cancelled.resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      signal.throwIfAborted();
      const result = step(record, { lane: lane.name, call: record.laneIndex, signal });
      const produced = await Promise.race([result, cancelled.promise]);
      signal.throwIfAborted();
      if (produced === undefined) throw new TestkitError('The step function returned no reply');
      if (produced.hold !== undefined) this.holds.claim(produced.hold.name, produced.hold.beforeUnit, produced.label);
      return produced;
    } catch (error) {
      if (signal.aborted) {
        record.transition('aborted');
        return undefined;
      }
      this.problem(`the step for request #${record.index} on lane ${JSON.stringify(lane.name)} threw: ${describeError(error)}`);
      respondEncoded(sink, codec, { status: 400, message: 'testkit step factory threw', type: 'testkit_error' });
      record.transition('failed');
      return undefined;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private playbackOf(step: ScriptedStep, record: RecordedRequest, codec: ProtocolCodec, sink: PlaybackSink): Playback {
    const context: EncodeContext = {
      responseId: `testkit-${record.index}`,
      model: record.view.model ?? DEFAULT_MODELS[0] ?? 'testkit-model',
      usage: step.kind === 'reply' ? resolveUsage(step, record.rawBody) : null,
      callId: (callIndex, call) => call.id ?? this.callId(record.index, callIndex),
    };
    return {
      codec,
      request: record,
      holds: this.holds,
      context,
      defaultIntervalMs: this.options.intervalMs ?? 0,
      sink,
      problem: (message) => this.problem(`request #${record.index}: ${message}`),
    };
  }

  private classify(facts: RequestFacts): LaneState {
    for (const route of this.routes) {
      let matched: boolean;
      try {
        matched = route.matcher?.(facts) === true;
      } catch (error) {
        throw new TestkitError(`the matcher of lane ${JSON.stringify(route.name)} threw: ${messageOf(error)}`, { cause: error });
      }
      if (matched) return route;
    }
    const lane = this.builtIn.get(builtInLaneOf(facts));
    if (lane === undefined) throw new TestkitError('built-in lanes are missing');
    return lane;
  }

  private authorized(incoming: IncomingRequest): boolean {
    if (this.options.apiKey === undefined) return true;
    return credentialOf(incoming) === this.options.apiKey;
  }

  private respondModels(incoming: IncomingRequest, sink: PlaybackSink): void {
    if (!this.authorized(incoming)) {
      this.problem(`request GET ${incoming.path} used the wrong API key`);
      respondPlain(sink, 401, { error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' } });
      return;
    }
    const models = this.options.models ?? DEFAULT_MODELS;
    respondPlain(sink, 200, { object: 'list', data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'testkit' })) });
  }

  private claimHold(step: Step): void {
    if (typeof step === 'function' || step.hold === undefined) return;
    this.holds.claim(step.hold.name, step.hold.beforeUnit, step.label);
  }

  private waitFor<T>(checkReady: (settle: (value: T) => void) => void, options: WaitOptions, describe: () => string): Promise<T> {
    return waitForModelEvent<T>(
      this.closing.signal,
      (settle) => {
        const check = (): void => checkReady(settle);
        this.arrivalListeners.add(check);
        this.stateListeners.add(check);
        return () => {
          this.arrivalListeners.delete(check);
          this.stateListeners.delete(check);
        };
      },
      {
        timeoutMs: options.timeoutMs ?? TIMEOUTS.request,
        describe: () => `${describe()}; received ${this.records.length} request(s)${summarize(this.records)}`,
      },
    );
  }

  private problem(message: string): void {
    this.recordedProblems.push(message);
  }

  private notify(listeners: Set<() => void>): void {
    for (const listener of listeners) listener();
  }
}

function respondEncoded(sink: PlaybackSink, codec: ProtocolCodec, error: ErrorSpec): void {
  const response = codec.encodeError(error);
  sink.head(response.status, response.headers);
  sink.write(response.body);
  sink.end();
}

function respondPlain(sink: PlaybackSink, status: number, payload: unknown): void {
  sink.head(status, { 'content-type': 'application/json' });
  sink.write(JSON.stringify(payload));
  sink.end();
}

function credentialOf(incoming: IncomingRequest): string | undefined {
  const authorization = incoming.headers['authorization'];
  if (authorization?.startsWith('Bearer ') === true) return authorization.slice('Bearer '.length);
  const header = incoming.headers['x-api-key'] ?? incoming.headers['x-goog-api-key'];
  if (header !== undefined) return header;
  return new URL(incoming.path, 'http://testkit.invalid').searchParams.get('key') ?? undefined;
}

function describeStep(step: Step): string {
  if (typeof step !== 'function') return step.label;
  return step.name === '' ? 'a step function' : `step function ${step.name}`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarize(records: readonly ModelRequest[]): string {
  if (records.length === 0) return '';
  const lines = records.slice(-5).map(
    (request) => `\n  #${request.index} ${request.lane} ${request.state} first user text ${JSON.stringify(request.firstUserText.slice(0, 80))}`,
  );
  return `; latest:${lines.join('')}`;
}
