export const ARTEX_DEFAULT_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;

export interface ArtexLlmCaptureAttempt {
  readonly status: number;
  readonly body: string;
}

interface MutableAttempt {
  readonly status: number;
  readonly chunks: string[];
  bytes: number;
}

export class ArtexLlmWireCapture {
  private readonly maxBytes: number;
  private request = '';
  private readonly recordedAttempts: MutableAttempt[] = [];
  private readonly decoder = new TextDecoder();

  constructor(maxBytes: number = ARTEX_DEFAULT_CAPTURE_MAX_BYTES) {
    this.maxBytes = Math.max(0, maxBytes);
  }

  setRequest(body: string): void {
    if (body.length === 0 || this.request.length > 0) return;
    this.request = this.truncateString(body, this.maxBytes);
  }

  beginAttempt(status: number): {
    appendText(chunk: string): void;
    appendBytes(chunk: Uint8Array): void;
  } {
    const attempt: MutableAttempt = { status, chunks: [], bytes: 0 };
    this.recordedAttempts.push(attempt);
    return {
      appendText: (chunk: string) => {
        if (chunk.length === 0 || attempt.bytes >= this.maxBytes) return;
        const remaining = this.maxBytes - attempt.bytes;
        const clipped = this.truncateString(chunk, remaining);
        attempt.chunks.push(clipped);
        attempt.bytes += Buffer.byteLength(clipped, 'utf8');
      },
      appendBytes: (chunk: Uint8Array) => {
        if (chunk.byteLength === 0 || attempt.bytes >= this.maxBytes) return;
        const remaining = this.maxBytes - attempt.bytes;
        const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
        attempt.chunks.push(this.decoder.decode(slice, { stream: true }));
        attempt.bytes += slice.byteLength;
      },
    };
  }

  recordResponse(status: number, body: string | Uint8Array): void {
    const sink = this.beginAttempt(status);
    if (typeof body === 'string') {
      sink.appendText(body);
    } else {
      sink.appendBytes(body);
    }
  }

  teeResponse(
    status: number,
    body: ReadableStream<Uint8Array> | null,
  ): ReadableStream<Uint8Array> | null {
    const sink = this.beginAttempt(status);
    if (body === null) return null;

    const reader = body.getReader();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        sink.appendBytes(value);
        controller.enqueue(value);
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    });
  }

  rawRequest(): string {
    return this.request;
  }

  rawResponse(): string {
    if (this.recordedAttempts.length === 0) return '';
    if (this.recordedAttempts.length === 1) {
      return this.recordedAttempts[0]!.chunks.join('');
    }
    const parts: string[] = [];
    for (let i = 0; i < this.recordedAttempts.length; i += 1) {
      const attempt = this.recordedAttempts[i]!;
      const body = attempt.chunks.join('');
      parts.push(`===== attempt ${String(i + 1)}/${String(this.recordedAttempts.length)} — HTTP ${String(attempt.status)} =====\n`);
      parts.push(body);
      if (!body.endsWith('\n')) {
        parts.push('\n');
      }
    }
    return parts.join('');
  }

  attempts(): ArtexLlmCaptureAttempt[] {
    return this.recordedAttempts.map((attempt) => ({
      status: attempt.status,
      body: attempt.chunks.join(''),
    }));
  }

  private truncateString(value: string, maxBytes: number): string {
    if (maxBytes <= 0) return '';
    const buf = Buffer.from(value, 'utf8');
    if (buf.byteLength <= maxBytes) return value;
    return buf.subarray(0, maxBytes).toString('utf8');
  }
}

async function extractRequestBodyText(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<string> {
  const body = init?.body;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8');
  if (input instanceof Request && input.body !== null) {
    try {
      return await input.clone().text();
    } catch {
      return '';
    }
  }
  return '';
}

export function wrapFetchWithCapture(
  baseFetch: typeof fetch,
  capture: ArtexLlmWireCapture,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const reqBody = await extractRequestBodyText(input, init);
    capture.setRequest(reqBody);

    const response = await baseFetch(input, init);
    const teedBody = capture.teeResponse(response.status, response.body);
    return new Response(teedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
}
