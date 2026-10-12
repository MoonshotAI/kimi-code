import type { Request, Response } from 'express';

import {
  SessionSpaceError,
  type ContentPart,
  type UserMessage,
} from '@moonshot-ai/agent-core';

export const ErrorCode = {
  SUCCESS: 0,
  VALIDATION_FAILED: 40001,
  PROVIDER_OAUTH_MANAGED: 40003,
  CATALOG_IMPORT_INVALID: 40004,
  REGISTRY_IMPORT_INVALID: 40005,
  SESSION_NOT_FOUND: 40401,
  PROMPT_NOT_FOUND: 40402,
  APPROVAL_NOT_FOUND: 40404,
  QUESTION_NOT_FOUND: 40405,
  TASK_NOT_FOUND: 40406,
  FILE_NOT_FOUND: 40407,
  MCP_SERVER_NOT_FOUND: 40408,
  FS_PATH_NOT_FOUND: 40409,
  WORKSPACE_NOT_FOUND: 40410,
  FS_PERMISSION_DENIED: 40411,
  PROVIDER_NOT_FOUND: 40412,
  MODEL_NOT_FOUND: 40413,
  SKILL_NOT_FOUND: 40415,
  CATALOG_ENTRY_NOT_FOUND: 40417,
  CAPABILITY_NOT_FOUND: 40418,
  PLUGIN_NOT_FOUND: 40419,
  AGENT_NOT_FOUND: 40421,
  ROUTE_NOT_FOUND: 40422,
  SESSION_BUSY: 40901,
  APPROVAL_ALREADY_RESOLVED: 40902,
  TASK_ALREADY_FINISHED: 40904,
  FS_IS_DIRECTORY: 40906,
  FS_IS_BINARY: 40907,
  FS_GIT_UNAVAILABLE: 40908,
  QUESTION_DISMISSED: 40909,
  COMPACTION_UNABLE: 40910,
  SESSION_UNDO_UNAVAILABLE: 40911,
  SKILL_NOT_ACTIVATABLE: 40912,
  GOAL_ALREADY_EXISTS: 40913,
  GOAL_NOT_FOUND: 40914,
  GOAL_STATUS_INVALID: 40915,
  GOAL_NOT_RESUMABLE: 40916,
  GOAL_OBJECTIVE_EMPTY: 40917,
  GOAL_OBJECTIVE_TOO_LONG: 40918,
  FS_ALREADY_EXISTS: 40919,
  PROVIDER_ALREADY_EXISTS: 40921,
  PAGE_TOKEN_MISMATCH: 40922,
  SESSION_TITLE_UNAVAILABLE: 40923,
  CAPABILITY_INSTALL_IN_PROGRESS: 40924,
  CAPABILITY_UNSUPPORTED: 40925,
  REMOTE_CONTROL_ALREADY_RUNNING: 40928,
  MCP_OAUTH_FAILED: 40929,
  SESSION_BTW_UNAVAILABLE: 40931,
  INTERACTION_UNAVAILABLE: 40932,
  TASK_UNAVAILABLE: 40933,
  SKILL_CATALOG_UNAVAILABLE: 40934,
  GOAL_UNAVAILABLE: 40935,
  SESSION_EXPORT_UNAVAILABLE: 40936,
  REMOTE_CONTROL_UNAVAILABLE: 40937,
  MODELS_DEV_UNAVAILABLE: 40938,
  SESSION_EXISTS: 40939,
  SKILL_UNAVAILABLE: 40940,
  CONFIG_UNAVAILABLE: 40941,
  PROVIDER_CATALOG_UNAVAILABLE: 40942,
  PLUGIN_UNAVAILABLE: 40943,
  MCP_UNAVAILABLE: 40944,
  WORKSPACES_UNAVAILABLE: 40945,
  WORKSPACE_FS_UNAVAILABLE: 40946,
  CAPABILITIES_UNAVAILABLE: 40947,
  OAUTH_UNAVAILABLE: 40948,
  FILE_HISTORY_UNAVAILABLE: 40949,
  MEDIA_UNAVAILABLE: 40950,
  FILES_UNAVAILABLE: 40951,
  SESSION_INDEX_UNAVAILABLE: 40952,
  FS_TOO_LARGE: 41302,
  FS_TOO_MANY_RESULTS: 41303,
  FS_PATH_ESCAPES_SESSION: 41304,
  FS_GREP_TIMEOUT: 41305,
  INTERNAL_ERROR: 50001,
  REMOTE_CONTROL_FAILED: 50002,
  CATALOG_UNAVAILABLE: 50004,
} as const;

export function requestId(request: Request): string {
  const header = request.get('x-request-id');
  return header === undefined || header.length === 0 ? '' : header;
}

export function sendOk(request: Request, response: Response, data: unknown): void {
  response.status(200).json({
    code: ErrorCode.SUCCESS,
    msg: 'success',
    data,
    request_id: requestId(request),
  });
}

export function sendErr(request: Request, response: Response, code: number, msg: string): void {
  response.status(200).json({
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
    sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, error.message);
    return true;
  }
  if (error.reason === 'already-exists') {
    sendErr(request, response, ErrorCode.SESSION_EXISTS, error.message);
    return true;
  }
  sendErr(request, response, ErrorCode.VALIDATION_FAILED, error.message);
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
