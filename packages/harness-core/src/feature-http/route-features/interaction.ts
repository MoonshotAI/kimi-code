import type { Request, Response } from 'express';

import { useApp } from '@moonshot-ai/agent-core';

import {
  InteractionRef,
  INTERACTION_TAG_SESSION_ID,
  INTERACTION_TAG_TOOL_CALL_ID,
  INTERACTION_TAG_TURN_ID,
  type Interaction,
  type Interactions,
} from '#/features/interaction/index';

import { useHttpRoute } from '../feature';
import { parseActionSuffix } from '../route/action-suffix';
import { ErrorCode, param, requestId, sendErr, sendOk } from '../route/http';
import { resumeSession } from '../route/resume-session';

export interface ApprovalView {
  readonly approval_id: string;
  readonly session_id: string;
  readonly turn_id?: number;
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly action: string;
  readonly tool_input_display: unknown;
  readonly created_at: string;
  readonly expires_at: string;
}

interface ApprovalResponseBody {
  readonly decision: 'approved' | 'rejected' | 'cancelled';
  readonly scope?: 'session';
  readonly feedback?: string;
  readonly selectedLabel?: string;
}

const APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000;

export interface QuestionOptionView {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface QuestionItemView {
  readonly id: string;
  readonly question: string;
  readonly header?: string;
  readonly options: readonly QuestionOptionView[];
  readonly multi_select?: boolean;
  readonly allow_other?: boolean;
}

export interface QuestionView {
  readonly question_id: string;
  readonly session_id: string;
  readonly turn_id?: number;
  readonly tool_call_id?: string;
  readonly questions: readonly QuestionItemView[];
  readonly created_at: string;
}

type WireAnswer =
  | { readonly kind: 'single'; readonly optionId: string }
  | { readonly kind: 'multi'; readonly optionIds: readonly string[] }
  | { readonly kind: 'other'; readonly text: string }
  | { readonly kind: 'multi_with_other'; readonly optionIds: readonly string[]; readonly otherText: string }
  | { readonly kind: 'skipped' };

type AnswerMethod = 'enter' | 'space' | 'number_key' | 'click';

const QUESTION_ACTIONS = ['dismiss'] as const;

export function useInteractionRoutes(prefix: string): void {
  useHttpRoute({
    id: 'sessions.approvals.list',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/approvals`,
    handler: async (request, response) => {
      const resolved = await interactionFacade(request, response);
      if (resolved === undefined) return;
      const pending = resolved.facade.findAll({
        kind: 'approval',
        resolved: false,
        tags: { [INTERACTION_TAG_SESSION_ID]: resolved.sessionId },
      });
      sendOk(request, response, {
        items: pending.map((interaction) => approvalView(interaction, resolved.sessionId)),
      });
    },
  });

  useHttpRoute({
    id: 'sessions.approvals.resolve',
    method: 'POST',
    path: `${prefix}/sessions/:session_id/approvals/:approval_id`,
    handler: async (request, response) => {
      const approvalId = param(request, 'approval_id');
      if (approvalId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'approval_id is required');
        return;
      }
      const body = readApprovalResponse(request.body);
      if (body === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          'decision must be one of approved, rejected, cancelled; scope must be session; feedback and selected_label must be strings',
        );
        return;
      }
      const resolved = await interactionFacade(request, response);
      if (resolved === undefined) return;
      const tags = { [INTERACTION_TAG_SESSION_ID]: resolved.sessionId };
      const pending = resolved.facade.findOne({ id: approvalId, kind: 'approval', resolved: false, tags });
      if (pending === undefined) {
        if (resolved.facade.findOne({ id: approvalId, kind: 'approval', resolved: true, tags }) !== undefined) {
          response.status(200).json({
            code: ErrorCode.APPROVAL_ALREADY_RESOLVED,
            msg: `approval ${approvalId} already resolved`,
            data: { resolved: false },
            request_id: requestId(request),
          });
          return;
        }
        sendErr(request, response, ErrorCode.APPROVAL_NOT_FOUND, `approval ${approvalId} not found`);
        return;
      }
      resolved.facade.respond(approvalId, {
        decision: body.decision,
        scope: body.scope,
        feedback: body.feedback,
        selectedLabel: body.selectedLabel,
      });
      sendOk(request, response, { resolved: true, resolved_at: new Date().toISOString() });
    },
  });

  useHttpRoute({
    id: 'sessions.questions.list',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/questions`,
    handler: async (request, response) => {
      const resolved = await interactionFacade(request, response);
      if (resolved === undefined) return;
      const pending = resolved.facade.findAll({
        kind: 'question',
        resolved: false,
        tags: { [INTERACTION_TAG_SESSION_ID]: resolved.sessionId },
      });
      sendOk(request, response, {
        items: pending.map((interaction) => questionView(interaction, resolved.sessionId)),
      });
    },
  });

  useHttpRoute({
    id: 'sessions.questions.resolve',
    method: 'POST',
    path: `${prefix}/sessions/:session_id/questions/:tail`,
    handler: async (request, response) => {
      const tail = param(request, 'tail');
      if (tail === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'question_id is required');
        return;
      }
      const parsed = parseActionSuffix({
        tail,
        allowedActions: QUESTION_ACTIONS,
        defaultAction: 'resolve',
        resourceLabel: 'question',
      });
      const resolved = await interactionFacade(request, response);
      if (resolved === undefined) return;
      const tags = { [INTERACTION_TAG_SESSION_ID]: resolved.sessionId };
      let questionId: string;
      let action: 'resolve' | 'dismiss';
      if (parsed.kind === 'invalid') {
        if (
          resolved.facade.findOne({ id: tail, kind: 'question', resolved: false, tags }) !== undefined ||
          resolved.facade.findOne({ id: tail, kind: 'question', resolved: true, tags }) !== undefined
        ) {
          questionId = tail;
          action = 'resolve';
        } else {
          sendErr(request, response, ErrorCode.VALIDATION_FAILED, parsed.reason);
          return;
        }
      } else {
        questionId = parsed.id;
        action = parsed.kind === 'bare' ? 'resolve' : parsed.action;
      }
      const pending = resolved.facade.findOne({ id: questionId, kind: 'question', resolved: false, tags });
      if (pending === undefined) {
        if (resolved.facade.findOne({ id: questionId, kind: 'question', resolved: true, tags }) !== undefined) {
          response.status(200).json({
            code: ErrorCode.APPROVAL_ALREADY_RESOLVED,
            msg: `question ${questionId} already resolved`,
            data: { resolved: false },
            request_id: requestId(request),
          });
          return;
        }
        sendErr(request, response, ErrorCode.QUESTION_NOT_FOUND, `question ${questionId} not found`);
        return;
      }
      if (action === 'dismiss') {
        resolved.facade.respond(questionId, null);
        response.status(200).json({
          code: ErrorCode.QUESTION_DISMISSED,
          msg: `question ${questionId} dismissed`,
          data: { dismissed: true, dismissed_at: new Date().toISOString() },
          request_id: requestId(request),
        });
        return;
      }
      const body = readQuestionResponse(request.body);
      if (body === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          'answers must be a record of question answers; method must be one of enter, space, number_key, click',
        );
        return;
      }
      resolved.facade.respond(
        questionId,
        flattenAnswers(body, questionView(pending, resolved.sessionId)),
      );
      sendOk(request, response, { resolved: true, resolved_at: new Date().toISOString() });
    },
  });
}

async function interactionFacade(
  request: Request,
  response: Response,
): Promise<{ readonly sessionId: string; readonly facade: Interactions } | undefined> {
  const sessionId = param(request, 'session_id');
  if (sessionId === undefined) {
    sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
    return undefined;
  }
  const session = await resumeSession(useApp(), sessionId);
  if (session === undefined) {
    sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    return undefined;
  }
  const facade = session.resolve(InteractionRef);
  if (facade === undefined) {
    sendErr(
      request,
      response,
      ErrorCode.INTERACTION_UNAVAILABLE,
      'interactions are unavailable (interaction feature is not installed)',
    );
    return undefined;
  }
  return { sessionId, facade };
}

function approvalView(interaction: Interaction, sessionId: string): ApprovalView {
  const payload = interaction.payload as {
    toolCallId?: unknown;
    toolName?: unknown;
    action?: unknown;
    display?: unknown;
  };
  const turnId = interaction.tags[INTERACTION_TAG_TURN_ID];
  return {
    approval_id: interaction.id,
    session_id: sessionId,
    turn_id: typeof turnId === 'number' ? turnId : undefined,
    tool_call_id:
      typeof payload.toolCallId === 'string' && payload.toolCallId.length > 0
        ? payload.toolCallId
        : interaction.id,
    tool_name: typeof payload.toolName === 'string' ? payload.toolName : '',
    action: typeof payload.action === 'string' ? payload.action : '',
    tool_input_display: payload.display,
    created_at: new Date(interaction.createdAt).toISOString(),
    expires_at: new Date(interaction.createdAt + APPROVAL_EXPIRY_MS).toISOString(),
  };
}

function readApprovalResponse(body: unknown): ApprovalResponseBody | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as { [key: string]: unknown };
  const decision = record['decision'];
  if (decision !== 'approved' && decision !== 'rejected' && decision !== 'cancelled') return undefined;
  const scope = record['scope'];
  if (scope !== undefined && scope !== 'session') return undefined;
  const feedback = record['feedback'];
  if (feedback !== undefined && typeof feedback !== 'string') return undefined;
  const selectedLabel = record['selected_label'];
  if (selectedLabel !== undefined && typeof selectedLabel !== 'string') return undefined;
  return { decision, scope, feedback, selectedLabel };
}

function questionView(interaction: Interaction, sessionId: string): QuestionView {
  const turnId = interaction.tags[INTERACTION_TAG_TURN_ID];
  const toolCallId = interaction.tags[INTERACTION_TAG_TOOL_CALL_ID];
  const raw = (interaction.payload as { questions?: unknown } | null | undefined)?.questions;
  return {
    question_id: interaction.id,
    session_id: sessionId,
    turn_id: typeof turnId === 'number' ? turnId : undefined,
    tool_call_id: typeof toolCallId === 'string' && toolCallId.length > 0 ? toolCallId : undefined,
    questions: Array.isArray(raw) ? (raw as readonly QuestionItemView[]) : [],
    created_at: new Date(interaction.createdAt).toISOString(),
  };
}

function flattenAnswers(
  body: { readonly answers: Readonly<Record<string, WireAnswer>>; readonly method?: AnswerMethod },
  request: QuestionView,
): { readonly answers: Record<string, string>; readonly method?: AnswerMethod } {
  const itemsById = new Map(request.questions.map((item) => [item.id, item]));
  const flattened: Record<string, string> = {};
  for (const [questionId, answer] of Object.entries(body.answers)) {
    const item = itemsById.get(questionId);
    const key = item?.question ?? questionId;
    const optionText = (id: string): string =>
      item?.options.find((option) => option.id === id)?.label ?? id;
    switch (answer.kind) {
      case 'single':
        flattened[key] = optionText(answer.optionId);
        break;
      case 'multi':
        flattened[key] = answer.optionIds.map(optionText).join(', ');
        break;
      case 'other':
        flattened[key] = answer.text;
        break;
      case 'multi_with_other':
        flattened[key] = [...answer.optionIds.map(optionText), answer.otherText].join(', ');
        break;
      case 'skipped':
        break;
    }
  }
  return {
    answers: flattened,
    method: body.method !== undefined && body.method !== 'click' ? body.method : undefined,
  };
}

function readQuestionResponse(
  body: unknown,
): { readonly answers: Record<string, WireAnswer>; readonly method?: AnswerMethod } | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as { [key: string]: unknown };
  const answers = record['answers'];
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) return undefined;
  const parsed: Record<string, WireAnswer> = {};
  for (const [key, value] of Object.entries(answers)) {
    const answer = readAnswer(value);
    if (answer === undefined) return undefined;
    parsed[key] = answer;
  }
  const method = record['method'];
  if (
    method !== undefined &&
    method !== 'enter' &&
    method !== 'space' &&
    method !== 'number_key' &&
    method !== 'click'
  ) {
    return undefined;
  }
  return { answers: parsed, method };
}

function readAnswer(value: unknown): WireAnswer | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as { [key: string]: unknown };
  switch (record['kind']) {
    case 'single':
      return typeof record['option_id'] === 'string' && record['option_id'].length > 0
        ? { kind: 'single', optionId: record['option_id'] }
        : undefined;
    case 'multi':
      return isStringArray(record['option_ids']) && record['option_ids'].length > 0
        ? { kind: 'multi', optionIds: record['option_ids'] }
        : undefined;
    case 'other':
      return typeof record['text'] === 'string' ? { kind: 'other', text: record['text'] } : undefined;
    case 'multi_with_other':
      return isStringArray(record['option_ids']) && typeof record['other_text'] === 'string'
        ? { kind: 'multi_with_other', optionIds: record['option_ids'], otherText: record['other_text'] }
        : undefined;
    case 'skipped':
      return { kind: 'skipped' };
    default:
      return undefined;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
