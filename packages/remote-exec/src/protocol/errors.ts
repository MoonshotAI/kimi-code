import type { JsonRpcErrorBody } from './messages';

export const RpcErrorCode = {
  NotFound: -32004,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;
export type RpcErrorCode = (typeof RpcErrorCode)[keyof typeof RpcErrorCode];

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }

  static fromErrorBody(body: JsonRpcErrorBody): RpcError {
    return new RpcError(body.code, body.message, body.data);
  }

  toErrorBody(): JsonRpcErrorBody {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

export function toRpcError(error: unknown, fallbackCode: number = RpcErrorCode.InternalError): RpcError {
  if (error instanceof RpcError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RpcError(fallbackCode, message);
}
