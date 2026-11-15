export type RequestId = string | number;

export interface JsonRpcRequest {
  readonly id: RequestId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly id: RequestId;
  readonly result: unknown;
}

export interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcErrorResponse {
  readonly id: RequestId;
  readonly error: JsonRpcErrorBody;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse
  | JsonRpcErrorResponse;

export class ProtocolViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolViolationError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === 'string' || typeof value === 'number';
}

function requireRequestId(value: unknown): RequestId {
  if (!isRequestId(value)) {
    throw new ProtocolViolationError('id must be a string or number');
  }
  return value;
}

export function classifyMessage(value: unknown): JsonRpcMessage {
  if (!isPlainObject(value)) {
    throw new ProtocolViolationError('message must be a JSON object');
  }
  if ('method' in value) {
    if (typeof value['method'] !== 'string') {
      throw new ProtocolViolationError('method must be a string');
    }
    const method = value['method'];
    if ('id' in value) {
      return { id: requireRequestId(value['id']), method, params: value['params'] };
    }
    return { method, params: value['params'] };
  }
  if ('result' in value) {
    if (!('id' in value)) {
      throw new ProtocolViolationError('response must carry an id');
    }
    return { id: requireRequestId(value['id']), result: value['result'] };
  }
  if (!('id' in value)) {
    throw new ProtocolViolationError('error response must carry an id');
  }
  const error = value['error'];
  if (!isPlainObject(error) || typeof error['code'] !== 'number' || typeof error['message'] !== 'string') {
    throw new ProtocolViolationError('error must carry a numeric code and a message');
  }
  return { id: requireRequestId(value['id']), error: { code: error['code'], message: error['message'], data: error['data'] } };
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'method' in message && 'id' in message;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return 'method' in message && !('id' in message);
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return 'result' in message;
}

export function isErrorResponse(message: JsonRpcMessage): message is JsonRpcErrorResponse {
  return 'error' in message;
}
