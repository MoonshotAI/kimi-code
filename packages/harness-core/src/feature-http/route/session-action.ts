import type { Request, Response } from 'express';

import {
  createCollection,
  useCleanup,
  useCollection,
} from '@moonshot-ai/agent-core/kernel/index';
import { currentUnit, lineage } from '@moonshot-ai/agent-core/kernel/runtime';

import { useHttpRoute } from '../scope';
import { parseActionSuffix } from './action-suffix';
import { ErrorCode, param, sendErr } from './http';

export interface SessionActionBody {
  readonly instruction?: string;
  readonly count?: number;
  readonly pageSize?: number;
}

export interface SessionActionInput {
  readonly sessionId: string;
  readonly body: SessionActionBody;
  readonly request: Request;
  readonly response: Response;
}

export type SessionActionHandler = (input: SessionActionInput) => void | Promise<void>;

export interface SessionActionContribution {
  readonly action: string;
  readonly run: SessionActionHandler;
}

export const SessionActionContributions = createCollection<SessionActionContribution>('http.sessionActions');

export function useSessionAction(action: string, run: SessionActionHandler): void {
  const node = currentUnit();
  const root = [...lineage(node)].at(-1) ?? node;
  useCleanup(root.register(SessionActionContributions, { action, run }));
}

export function useSessionActionRoutes(prefix: string): void {
  const contributions = useCollection(SessionActionContributions);
  useHttpRoute({
    id: 'sessions.action',
    method: 'POST',
    path: `${prefix}/sessions/:tail`,
    handler: async (request, response) => {
      const tail = param(request, 'tail');
      if (tail === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      const entries = contributions.value;
      const parsed = parseActionSuffix({
        tail,
        allowedActions: entries.map((entry) => entry.action),
        resourceLabel: 'session',
      });
      if (parsed.kind !== 'action') {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`,
        );
        return;
      }
      const body = readSessionActionBody(request.body);
      if ('error' in body) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, body.error);
        return;
      }
      const entry = entries.find((candidate) => candidate.action === parsed.action);
      if (entry === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, `unsupported action: ${tail}`);
        return;
      }
      await entry.run({ sessionId: parsed.id, body, request, response });
    },
  });
}

export function readSessionActionBody(body: unknown): SessionActionBody | { readonly error: string } {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be an object' };
  const record = body as { [key: string]: unknown };
  const input: { instruction?: string; count?: number; pageSize?: number } = {};
  if (record['instruction'] !== undefined) {
    if (typeof record['instruction'] !== 'string') return { error: 'instruction must be a string' };
    input.instruction = record['instruction'];
  }
  if (record['count'] !== undefined) {
    const count = record['count'];
    if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) {
      return { error: 'count must be a positive integer' };
    }
    input.count = count;
  }
  if (record['page_size'] !== undefined) {
    const pageSize = record['page_size'];
    if (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return { error: 'page_size must be an integer between 1 and 100' };
    }
    input.pageSize = pageSize;
  }
  return input;
}
