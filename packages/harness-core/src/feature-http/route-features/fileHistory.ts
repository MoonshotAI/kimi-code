import type { Request, Response } from 'express';

import { useApp } from '@moonshot-ai/agent-core/app/index';
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';

import {
  FileHistoryRef,
  type FileHistoryCheckpointPhase,
  type FileHistoryFace,
} from '#/features/fileHistory/index';

import { agentFacade, unitsReady, useHttpRoute, useRootUnit } from '../scope';
import { ErrorCode, param, sendErr, sendOk } from '../route/http';
import { resumeSession } from '../route/resume-session';

export function useFileHistoryRoutes(prefix: string): void {
  const app = useApp();
  const root = useRootUnit();

  const resolveFileHistory = async (
    request: Request,
    response: Response,
  ): Promise<FileHistoryFace | undefined> => {
    const sessionId = param(request, 'session_id');
    if (sessionId === undefined) {
      sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
      return undefined;
    }
    const session = await resumeSession(app, sessionId);
    if (session === undefined) {
      sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
      return undefined;
    }
    await unitsReady(root);
    const face =
      session.agents.get(MAIN_AGENT_ID) === undefined
        ? undefined
        : agentFacade(root, FileHistoryRef, sessionId, MAIN_AGENT_ID);
    if (face === undefined) {
      sendErr(
        request,
        response,
        ErrorCode.FILE_HISTORY_UNAVAILABLE,
        'file history is unavailable (feature not mounted or no main agent yet)',
      );
      return undefined;
    }
    return face;
  };

  useHttpRoute({
    id: 'sessions.fileHistoryChanges',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/file-history/changes`,
    handler: async (request, response) => {
      const face = await resolveFileHistory(request, response);
      if (face === undefined) return;
      const turnId = readTurnId(request.query['turn_id']);
      if (turnId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'turn_id must be a non-negative integer');
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
      const face = await resolveFileHistory(request, response);
      if (face === undefined) return;
      const turnId = readTurnId(request.query['turn_id']);
      if (turnId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'turn_id must be a non-negative integer');
        return;
      }
      const path = request.query['path'];
      if (typeof path !== 'string' || path.length === 0) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'path is required');
        return;
      }
      const phase = request.query['phase'];
      if (phase !== undefined && phase !== 'start' && phase !== 'end') {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, "phase must be 'start' or 'end'");
        return;
      }
      const content = await face.contentAt(turnId, path, phase as FileHistoryCheckpointPhase | undefined);
      sendOk(request, response, { content: content ?? null });
    },
  });
}

function readTurnId(value: unknown): number | undefined {
  const raw = typeof value === 'string' && value.length > 0 ? Number(value) : NaN;
  return Number.isInteger(raw) && raw >= 0 ? raw : undefined;
}
