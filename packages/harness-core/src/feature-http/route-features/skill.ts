import type { Request, Response } from 'express';

import { MAIN_AGENT_ID, useApp, useInject } from '@moonshot-ai/agent-core';

import {
  SkillCatalogRef,
  SkillRef,
  type SkillFace,
  type SkillSource,
  type SkillSummary,
} from '#/features/skill/index';

import { useHttpRoute } from '../feature';
import { parseActionSuffix } from '../route/action-suffix';
import { ErrorCode, param, sendErr, sendOk } from '../route/http';
import { resumeSession } from '../route/resume-session';

export interface SkillView {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly source: SkillSource;
  readonly type?: string;
  readonly disable_model_invocation?: boolean;
}

const SKILL_ACTIONS = ['activate'] as const;

export function useSkillRoutes(prefix: string): void {
  useHttpRoute({
    id: 'sessions.skills',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/skills`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      const app = useApp();
      const facade = useInject(SkillCatalogRef).value;
      if ((await app.space.get(sessionId)) === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      if (facade === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.SKILL_CATALOG_UNAVAILABLE,
          'skill catalog is unavailable (skill feature is not installed)',
        );
        return;
      }
      await facade.ready;
      sendOk(request, response, { skills: facade.list().map(skillView) });
    },
  });

  useHttpRoute({
    id: 'sessions.skills.activate',
    method: 'POST',
    path: `${prefix}/sessions/:session_id/skills/:tail`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      const tail = param(request, 'tail');
      if (sessionId === undefined || tail === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      const parsed = parseActionSuffix({ tail, allowedActions: SKILL_ACTIONS, resourceLabel: 'skill_name' });
      if (parsed.kind !== 'action') {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`,
        );
        return;
      }
      const body = readActivateBody(request.body);
      if (body === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          'args must be a string and attachments are not supported',
        );
        return;
      }
      const session = await resumeSession(useApp(), sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      const agent = session.get(MAIN_AGENT_ID);
      if (agent === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${MAIN_AGENT_ID} does not exist`);
        return;
      }
      const facade: SkillFace | undefined = agent.resolve(SkillRef);
      if (facade === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.SKILL_UNAVAILABLE,
          'skill activation is unavailable (skill feature is not installed)',
        );
        return;
      }
      try {
        await facade.activate({ name: parsed.id, args: body.args });
      } catch (error) {
        if (sendSkillActivateErr(request, response, error)) return;
        throw error;
      }
      sendOk(request, response, { activated: true, skill_name: parsed.id });
    },
  });
}

function skillView(skill: SkillSummary): SkillView {
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    source: skill.source,
    type: skill.type,
    disable_model_invocation: skill.disableModelInvocation,
  };
}

function readActivateBody(body: unknown): { readonly args?: string } | undefined {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as { [key: string]: unknown };
  if (record['args'] !== undefined && typeof record['args'] !== 'string') return undefined;
  const attachments = record['attachments'];
  if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length > 0)) {
    return undefined;
  }
  return { args: typeof record['args'] === 'string' ? record['args'] : undefined };
}

function sendSkillActivateErr(request: Request, response: Response, error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (/^Skill ".*" was not found$/.test(error.message)) {
    sendErr(request, response, ErrorCode.SKILL_NOT_FOUND, error.message);
    return true;
  }
  if (/^Skill ".*" cannot be activated by the user$/.test(error.message)) {
    sendErr(request, response, ErrorCode.SKILL_NOT_ACTIVATABLE, error.message);
    return true;
  }
  if (error.message === 'Cannot activate skill while another turn is active') {
    sendErr(request, response, ErrorCode.SESSION_BUSY, error.message);
    return true;
  }
  return false;
}
