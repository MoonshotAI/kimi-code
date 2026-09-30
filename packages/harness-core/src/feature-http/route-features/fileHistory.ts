import type { Request, Response } from 'express';

import { MAIN_AGENT_ID, useApp } from '@moonshot-ai/agent-core';

import {
  FileHistoryRef,
  type FileHistoryCheckpointPhase,
  type FileHistoryFace,
} from '#/features/fileHistory/index';

import { useHttpRoute } from '../feature';
import { ErrorCode, param, sendErr, sendOk, tryResolve } from '../route/http';

export function useFileHistoryRoutes(prefix: string): void {
  useHttpRoute({
    id: 'sessions.fileHistoryChanges',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/file-history/changes`,
    handler: async (request, response) => {
      const face = resolveFileHistory(request, response);
      if (face === undefined) return;
      const turnId = readTurnId(request.query['turn_id']);
      if (turnId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'turn_id must be a non-negative integer', 400);
        return;
      }
      sendOk(request, response, {
        changes: await face.changes(turnId),
        recorded: await face.turnRecorded(turnId),
      });
    },
  });

  useHttpRoute({
    id: 'sessions.fileHistoryContent',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/file-history/content`,
    handler: async (request, response) => {
      const face = resolveFileHistory(request, response);
      if (face === undefined) return;
      const turnId = readTurnId(request.query['turn_id']);
      if (turnId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'turn_id must be a non-negative integer', 400);
        return;
      }
      const path = request.query['path'];
      if (typeof path !== 'string' || path.length === 0) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'path is required', 400);
        return;
      }
      const phase = request.query['phase'];
      if (phase !== undefined && phase !== 'start' && phase !== 'end') {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, "phase must be 'start' or 'end'", 400);
        return;
      }
      const content = await face.contentAt(turnId, path, phase as FileHistoryCheckpointPhase | undefined);
      sendOk(request, response, { content: content ?? null });
    },
  });
}

function resolveFileHistory(request: Request, response: Response): FileHistoryFace | undefined {
  const sessionId = param(request, 'session_id');
  if (sessionId === undefined) {
    sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required', 400);
    return undefined;
  }
  const session = useApp().get(sessionId);
  if (session === undefined) {
    sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`, 404);
    return undefined;
  }
  const main = session.get(MAIN_AGENT_ID);
  const face = main === undefined ? undefined : tryResolve(main, FileHistoryRef);
  if (face === undefined) {
    sendErr(
      request,
      response,
      ErrorCode.FILE_HISTORY_UNAVAILABLE,
      'file history is unavailable (feature not mounted or no main agent yet)',
      409,
    );
    return undefined;
  }
  return face;
}

function readTurnId(value: unknown): number | undefined {
  const raw = typeof value === 'string' && value.length > 0 ? Number(value) : NaN;
  return Number.isInteger(raw) && raw >= 0 ? raw : undefined;
}
