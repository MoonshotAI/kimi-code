import type { Request, Response } from 'express';

import type { ContentPart, UserMessage } from '@moonshot-ai/agent-core';

import { SessionSpaceError } from '#/host/session';

export const ErrorCode = {
  SUCCESS: 0,
  VALIDATION_FAILED: 40001,
  SESSION_NOT_FOUND: 40401,
  PROMPT_NOT_FOUND: 40402,
  AGENT_NOT_FOUND: 40421,
  SESSION_EXISTS: 40901,
} as const;

export function requestId(request: Request): string {
  const header = request.get('x-request-id');
  return header === undefined || header.length === 0 ? '' : header;
}

export function sendOk(request: Request, response: Response, data: unknown, status = 200): void {
  response.status(status).json({
    code: ErrorCode.SUCCESS,
    msg: 'success',
    data,
    request_id: requestId(request),
  });
}

export function sendErr(
  request: Request,
  response: Response,
  code: number,
  msg: string,
  status: number,
): void {
  response.status(status).json({
    code,
    msg,
    data: null,
    request_id: requestId(request),
  });
}

export function param(request: Request, name: string): string | undefined {
  const value = request.params[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readAgentId(request: Request): string | undefined {
  const query = request.query['agent_id'];
  if (typeof query === 'string' && query.length > 0) {
    return query;
  }
  const body = request.body;
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const value = (body as { agent_id?: unknown })['agent_id'];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function readUserMessage(body: unknown): UserMessage | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }
  const content = (body as { content?: unknown })['content'];
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const parts: ContentPart[] = [];
  for (const item of content) {
    const part = toContentPart(item);
    if (part === undefined) {
      return undefined;
    }
    parts.push(part);
  }
  return { role: 'user', content: parts };
}

export function sendFacadeErr(request: Request, response: Response, error: unknown): boolean {
  if (!(error instanceof SessionSpaceError)) {
    return false;
  }
  if (error.reason === 'not-found') {
    sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, error.message, 404);
    return true;
  }
  if (error.reason === 'already-exists') {
    sendErr(request, response, ErrorCode.SESSION_EXISTS, error.message, 409);
    return true;
  }
  sendErr(request, response, ErrorCode.VALIDATION_FAILED, error.message, 400);
  return true;
}

function toContentPart(value: unknown): ContentPart | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const part = value as { [key: string]: unknown };
  if (part['type'] === 'text' && typeof part['text'] === 'string') {
    return { type: 'text', text: part['text'] };
  }
  if (part['type'] === 'image_url' && part['imageUrl'] !== null && typeof part['imageUrl'] === 'object') {
    const imageUrl = part['imageUrl'] as { [key: string]: unknown };
    if (typeof imageUrl['url'] === 'string') {
      return {
        type: 'image_url',
        imageUrl: {
          url: imageUrl['url'],
          name: typeof imageUrl['name'] === 'string' ? imageUrl['name'] : undefined,
        },
      };
    }
  }
  if (part['type'] === 'image' && part['source'] !== null && typeof part['source'] === 'object') {
    const source = part['source'] as { [key: string]: unknown };
    if (source['kind'] === 'url' && typeof source['url'] === 'string') {
      return { type: 'image_url', imageUrl: { url: source['url'] } };
    }
  }
  return undefined;
}
