import type { ResponseMessage } from '../../../protocol/ws-control';

export interface PingFrame {
  type: 'ping';
}

export function buildPing(): PingFrame {
  return { type: 'ping' };
}

export function buildResponse(
  requestId: string,
  code: number,
  msg?: string,
  task?: ResponseMessage['task'],
): ResponseMessage {
  return { type: 'response', request_id: requestId, code, msg, task };
}
