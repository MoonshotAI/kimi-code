import {
  llmStatusErrorMessage,
  type LlmRemoteErrorKind,
  type LlmRemoteErrorMessage,
} from '#/llm/response';

interface MiniMaxBusinessError {
  readonly code: number;
  readonly message: string;
}

export function miniMaxBusinessErrorOf(error: unknown): MiniMaxBusinessError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const body = error as {
    base_resp?: { status_code?: unknown; status_msg?: unknown };
    error?: { base_resp?: { status_code?: unknown; status_msg?: unknown } };
  };
  const base = body.base_resp ?? body.error?.base_resp;
  const code = typeof base?.status_code === 'number' ? base.status_code : undefined;
  if (code === undefined || code === 0) return undefined;
  return {
    code,
    message: typeof base?.status_msg === 'string' && base.status_msg.length > 0
      ? base.status_msg
      : `MiniMax error ${code}`,
  };
}

function classificationOf(code: number): { kind: LlmRemoteErrorKind; retryable: boolean } {
  switch (code) {
    case 1001:
    case 2066:
      return { kind: 'timeout', retryable: true };
    case 1000:
    case 1024:
    case 1033:
    case 2064:
      return { kind: 'overloaded', retryable: true };
    case 1002:
    case 1041:
    case 1045:
    case 2045:
    case 2046:
    case 2047:
    case 2056:
    case 2062:
      return { kind: 'rate_limit', retryable: true };
    case 1004:
    case 2049:
      return { kind: 'auth', retryable: false };
    case 1008:
    case 2053:
    case 2067:
      return { kind: 'quota_exhausted', retryable: false };
    case 1039:
      return { kind: 'context_overflow', retryable: false };
    case 2013:
      return { kind: 'request_structure', retryable: false };
    default:
      return { kind: 'provider', retryable: false };
  }
}

export function miniMaxErrorMessage(error: MiniMaxBusinessError): LlmRemoteErrorMessage {
  return {
    ...classificationOf(error.code),
    message: error.message,
    code: String(error.code),
  } as LlmRemoteErrorMessage;
}

export function withMiniMaxErrors(base: {
  readonly decodeError: (error: unknown, source?: 'stream') => LlmRemoteErrorMessage;
}) {
  return (error: unknown, source?: 'stream'): LlmRemoteErrorMessage => {
    const decoded = base.decodeError(error, source);
    const business = miniMaxBusinessErrorOf(error);
    if (business === undefined) return decoded;
    const classified = miniMaxErrorMessage(business);
    const status = llmStatusErrorMessage(decoded);
    if (status === null) return classified;
    return {
      ...status,
      kind: classified.kind,
      message: business.message,
      retryable: classified.retryable,
      code: String(business.code),
    } as LlmRemoteErrorMessage;
  };
}
