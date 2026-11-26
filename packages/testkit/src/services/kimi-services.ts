import { TestkitError } from '#/errors';
import { createFetchTransport } from '#/model/fetch-transport';
import { serveHttp, type HttpEndpoint } from '#/model/http-transport';
import type { PlaybackSink } from '#/model/playback';
import type { IncomingRequest } from '#/model/transport';

const VIRTUAL_ORIGIN = 'http://kimi-services.testkit.invalid';

export type KimiEndpoint = 'title' | 'feedback' | 'feedback-update' | 'upload-url' | 'upload-complete' | 'storage' | 'unknown';

export type HoldableEndpoint = Exclude<KimiEndpoint, 'unknown'>;

export interface ServiceRequest {
  readonly index: number;
  readonly endpoint: KimiEndpoint;
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly authorization?: string;
  readonly body: string;
  readonly bytes: Uint8Array;
  readonly json: unknown;
}

export interface ServiceFailure {
  readonly kind: 'failure';
  readonly status: number;
  readonly message: string;
}

export type TitleReply = string | ServiceFailure;

export interface UploadRecord {
  readonly id: number;
  readonly method: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly bytes?: Uint8Array;
  readonly completion?: Readonly<Record<string, unknown>>;
}

export interface FeedbackRecord {
  readonly id: number;
  readonly body: Readonly<Record<string, unknown>>;
  readonly updates: readonly Readonly<Record<string, unknown>>[];
  readonly uploads: readonly UploadRecord[];
}

export interface ServiceHold {
  readonly endpoint: HoldableEndpoint;
  readonly isReached: boolean;
  reached(): Promise<ServiceRequest>;
  release(): void;
}

export interface KimiServicesOptions {
  readonly accessToken?: string;
}

export interface KimiServices {
  readonly fetch: typeof fetch;
  readonly origin: string;
  readonly baseUrl: string;
  listen(): Promise<string>;
  title(...replies: readonly TitleReply[]): void;
  uploadMethod(method: string): void;
  holdNext(endpoint: HoldableEndpoint): ServiceHold;
  feedback(): readonly FeedbackRecord[];
  requests(endpoint?: KimiEndpoint): readonly ServiceRequest[];
  problems(): readonly string[];
  verify(): void;
  close(): Promise<void>;
}

export function serviceError(status: number, message = `testkit Kimi service error ${String(status)}`): ServiceFailure {
  return { kind: 'failure', status, message };
}

export function createKimiServices(options: KimiServicesOptions = {}): KimiServices {
  return new KimiServicesImpl(options);
}

export async function startKimiServices(options: KimiServicesOptions = {}): Promise<KimiServices> {
  const services = createKimiServices(options);
  await services.listen();
  return services;
}

interface HoldState {
  readonly endpoint: HoldableEndpoint;
  request?: ServiceRequest;
  released: boolean;
  abandoned: boolean;
  readonly reachedListeners: Array<(request: ServiceRequest) => void>;
  readonly releaseListeners: Array<() => void>;
}

interface MutableUpload {
  readonly id: number;
  readonly feedbackId: number;
  readonly method: string;
  readonly request: Record<string, unknown>;
  bytes?: Uint8Array;
  completion?: Record<string, unknown>;
}

interface MutableFeedback {
  readonly id: number;
  readonly body: Record<string, unknown>;
  readonly updates: Record<string, unknown>[];
}

class KimiServicesImpl implements KimiServices {
  readonly fetch: typeof fetch;
  private endpoint: HttpEndpoint | undefined;
  private readonly records: ServiceRequest[] = [];
  private readonly recordedProblems: string[] = [];
  private readonly titles: TitleReply[] = [];
  private readonly holds: HoldState[] = [];
  private readonly feedbacks: MutableFeedback[] = [];
  private readonly uploads: MutableUpload[] = [];
  private nextUploadMethod = 'PUT';

  constructor(private readonly options: KimiServicesOptions) {
    this.fetch = createFetchTransport((incoming, sink) => this.handle(incoming, sink));
  }

  get origin(): string {
    return this.endpoint?.origin ?? VIRTUAL_ORIGIN;
  }

  get baseUrl(): string {
    return `${this.origin}/coding/v1`;
  }

  async listen(): Promise<string> {
    this.endpoint ??= await serveHttp((incoming, sink) => this.handle(incoming, sink));
    return this.baseUrl;
  }

  title(...replies: readonly TitleReply[]): void {
    this.titles.push(...replies);
  }

  uploadMethod(method: string): void {
    this.nextUploadMethod = method;
  }

  holdNext(endpoint: HoldableEndpoint): ServiceHold {
    const state: HoldState = { endpoint, released: false, abandoned: false, reachedListeners: [], releaseListeners: [] };
    this.holds.push(state);
    return {
      endpoint,
      get isReached() {
        return state.request !== undefined;
      },
      reached: () =>
        state.request === undefined
          ? new Promise<ServiceRequest>((resolve) => state.reachedListeners.push(resolve))
          : Promise.resolve(state.request),
      release: () => release(state),
    };
  }

  feedback(): readonly FeedbackRecord[] {
    return this.feedbacks.map((feedback) => ({
      id: feedback.id,
      body: feedback.body,
      updates: [...feedback.updates],
      uploads: this.uploads
        .filter((upload) => upload.feedbackId === feedback.id)
        .map((upload) => ({ id: upload.id, method: upload.method, request: upload.request, bytes: upload.bytes, completion: upload.completion })),
    }));
  }

  requests(endpoint?: KimiEndpoint): readonly ServiceRequest[] {
    return endpoint === undefined ? [...this.records] : this.records.filter((record) => record.endpoint === endpoint);
  }

  problems(): readonly string[] {
    return [...this.recordedProblems];
  }

  verify(): void {
    const problems = [...this.recordedProblems];
    if (this.titles.length > 0) problems.push(`${String(this.titles.length)} scripted title repl${this.titles.length === 1 ? 'y was' : 'ies were'} never requested`);
    for (const state of this.holds) {
      if (state.request === undefined) problems.push(`a hold on the next ${state.endpoint} request was never reached`);
      else if (!state.released && !state.abandoned) problems.push(`a hold on ${state.endpoint} request #${String(state.request.index)} was reached but never released`);
    }
    if (problems.length > 0) throw new TestkitError(`The fake Kimi services found ${String(problems.length)} problem(s):\n- ${problems.join('\n- ')}`);
  }

  async close(): Promise<void> {
    for (const state of this.holds) release(state);
    await this.endpoint?.close();
  }

  private async handle(incoming: IncomingRequest, sink: PlaybackSink): Promise<void> {
    const path = incoming.path.split('?')[0] ?? incoming.path;
    const request = this.record(incoming, path);
    const hold = this.holds.find((state) => state.endpoint === request.endpoint && state.request === undefined);
    const answer = this.answer(request, path);
    if (hold !== undefined) {
      hold.request = request;
      for (const notify of hold.reachedListeners.splice(0)) notify(request);
      if (!hold.released) await waitForRelease(hold, sink.goneSignal);
      if (sink.gone) return;
    }
    answer(sink);
  }

  private answer(request: ServiceRequest, path: string): (sink: PlaybackSink) => void {
    if (request.endpoint === 'unknown') {
      this.problem(`unexpected request ${request.method} ${request.path}`);
      return (sink) => respond(sink, 404, { message: `the fake Kimi services have no endpoint ${request.method} ${path}` });
    }
    if (request.endpoint === 'storage') return (sink) => this.store(request, path, sink);
    if (this.options.accessToken !== undefined && request.authorization !== `Bearer ${this.options.accessToken}`) {
      this.problem(`request #${String(request.index)} to ${path} used the wrong access token`);
      return (sink) => respond(sink, 401, { message: 'invalid access token' });
    }
    const body = isRecord(request.json) ? request.json : {};
    switch (request.endpoint) {
      case 'title':
        return this.answerTitle(request, body);
      case 'feedback':
        return (sink) => {
          const feedback = { id: this.feedbacks.length + 1, body, updates: [] };
          this.feedbacks.push(feedback);
          respond(sink, 200, { feedback_id: feedback.id });
        };
      case 'feedback-update':
        return (sink) => {
          const feedback = this.ownedFeedback(body, sink);
          if (feedback === undefined) return;
          feedback.updates.push(body);
          respond(sink, 200, {});
        };
      case 'upload-url':
        return (sink) => {
          const feedback = this.ownedFeedback(body, sink);
          if (feedback === undefined) return;
          const upload: MutableUpload = { id: this.uploads.length + 1, feedbackId: feedback.id, method: this.nextUploadMethod, request: body };
          this.uploads.push(upload);
          respond(sink, 200, {
            upload: {
              id: upload.id,
              parts: [{ part_number: 1, url: `${this.origin}/storage/${String(upload.id)}`, size: body['file_size'], method: upload.method }],
            },
          });
        };
      case 'upload-complete':
        return (sink) => this.completeUpload(body, sink);
    }
  }

  private answerTitle(request: ServiceRequest, body: Record<string, unknown>): (sink: PlaybackSink) => void {
    const params = isRecord(body['params']) ? body['params'] : {};
    if (body['method'] !== 'chat_title' || typeof params['chat_content'] !== 'string') {
      this.problem(`request #${String(request.index)} to the tools endpoint is not a chat_title call with chat_content`);
      return (sink) => respond(sink, 400, { message: 'expected method chat_title with params.chat_content' });
    }
    const reply = this.titles.shift();
    if (reply === undefined) {
      this.problem(`request #${String(request.index)} asked for a session title, but no title was scripted`);
      return (sink) => respond(sink, 500, { message: 'no scripted title' });
    }
    return typeof reply === 'string'
      ? (sink) => respond(sink, 200, { title: reply })
      : (sink) => respond(sink, reply.status, { message: reply.message });
  }

  private completeUpload(body: Record<string, unknown>, sink: PlaybackSink): void {
    const upload = this.uploads.find((candidate) => candidate.id === body['upload_id']);
    if (upload === undefined) {
      this.problem(`upload_complete names upload ${String(body['upload_id'])}, which no upload_url request created`);
      respond(sink, 409, { message: 'unknown upload' });
      return;
    }
    const etags = Array.isArray(body['parts']) ? body['parts'].map((part: unknown) => (isRecord(part) ? part['etag'] : undefined)) : [];
    if (upload.bytes === undefined) this.problem(`upload ${String(upload.id)} was completed before its bytes reached storage`);
    else if (etags.length !== 1 || etags[0] !== etagOf(upload)) this.problem(`upload_complete for upload ${String(upload.id)} sent etags ${JSON.stringify(etags)}, expected [${JSON.stringify(etagOf(upload))}]`);
    upload.completion = body;
    respond(sink, 200, {});
  }

  private store(request: ServiceRequest, path: string, sink: PlaybackSink): void {
    const upload = this.uploads.find((candidate) => `/storage/${String(candidate.id)}` === path);
    if (upload === undefined) {
      this.problem(`storage request ${request.method} ${path} does not match an upload URL`);
      respond(sink, 404, { message: 'unknown upload' });
      return;
    }
    if (request.authorization !== undefined) {
      this.problem(`storage request for upload ${String(upload.id)} carried an Authorization header; signed URLs take none`);
      respond(sink, 403, { message: 'signed URLs take no Authorization header' });
      return;
    }
    if (request.method !== upload.method) {
      this.problem(`storage request for upload ${String(upload.id)} used ${request.method}, but the upload URL was signed for ${upload.method}`);
      respond(sink, 405, { message: `expected ${upload.method}` });
      return;
    }
    upload.bytes = request.bytes;
    sink.head(200, { etag: etagOf(upload) });
    sink.end();
  }

  private ownedFeedback(body: Record<string, unknown>, sink: PlaybackSink): MutableFeedback | undefined {
    const feedback = this.feedbacks.find((candidate) => candidate.id === Number(body['feedback_id']));
    if (feedback === undefined) respond(sink, 409, { message: 'not owned or expired' });
    return feedback;
  }

  private record(incoming: IncomingRequest, path: string): ServiceRequest {
    let json: unknown;
    try {
      json = incoming.body === '' ? undefined : JSON.parse(incoming.body);
    } catch {
      json = undefined;
    }
    const authorization = incoming.headers['authorization'];
    const request: ServiceRequest = {
      index: this.records.length,
      endpoint: this.endpointOf(incoming.method, path),
      method: incoming.method,
      path: incoming.path,
      headers: incoming.headers,
      ...(authorization === undefined ? {} : { authorization }),
      body: incoming.body,
      bytes: incoming.bytes,
      json,
    };
    this.records.push(request);
    return request;
  }

  private endpointOf(method: string, path: string): KimiEndpoint {
    if (/\/storage\/\d+$/.test(path)) return 'storage';
    if (method !== 'POST') return 'unknown';
    if (path.endsWith('/tools')) return 'title';
    if (path.endsWith('/feedback')) return 'feedback';
    if (path.endsWith('/feedback/update')) return 'feedback-update';
    if (path.endsWith('/feedback/upload_url')) return 'upload-url';
    if (path.endsWith('/feedback/upload_complete')) return 'upload-complete';
    return 'unknown';
  }

  private problem(message: string): void {
    this.recordedProblems.push(message);
  }
}

function etagOf(upload: MutableUpload): string {
  return `"testkit-etag-${String(upload.id)}"`;
}

function release(state: HoldState): void {
  if (state.released) return;
  state.released = true;
  for (const notify of state.releaseListeners.splice(0)) notify();
}

function waitForRelease(state: HoldState, gone: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const abandon = (): void => {
      state.abandoned = true;
      resolve();
    };
    if (gone.aborted) {
      abandon();
      return;
    }
    gone.addEventListener('abort', abandon, { once: true });
    state.releaseListeners.push(() => {
      gone.removeEventListener('abort', abandon);
      resolve();
    });
  });
}

function respond(sink: PlaybackSink, status: number, body: unknown): void {
  sink.head(status, { 'content-type': 'application/json' });
  sink.write(JSON.stringify(body));
  sink.end();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
