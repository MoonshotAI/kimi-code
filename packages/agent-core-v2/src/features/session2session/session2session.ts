import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

export const SESSION2SESSION_FLAG_ID = 'session2session';

export interface SessionSendInput {
  to: string;
  message: string;
  expectReply?: boolean;
  replyTo?: string;
  delivery?: 'queue' | 'steer';
}

export const SessionSendInputSchema: z.ZodType<SessionSendInput> = z.object({
  to: z.string().min(1).describe('Target session id or exact session title.'),
  message: z.string().min(1).describe('Message body to deliver to the target session.'),
  expectReply: z
    .boolean()
    .optional()
    .describe('Whether the recipient is expected to reply. Defaults to false; notifications normally do not need replies.'),
  replyTo: z
    .string()
    .min(1)
    .optional()
    .describe('Optional messageId from a received envelope. Preserves its chainId and records replyTo.'),
  delivery: z
    .enum(['queue', 'steer'])
    .optional()
    .describe('queue is the default. Use steer only for real-time correction of a running turn.'),
});

export interface SessionReadInput {
  to: string;
  limit?: number;
}

export const SessionReadInputSchema: z.ZodType<SessionReadInput> = z.object({
  to: z.string().min(1).describe('Target session id or exact session title.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .optional()
    .describe('Maximum latestAssistant characters, from 1 to 10000. Defaults to 2000.'),
});

export interface SessionCreateInput {
  cwd?: string;
  title?: string;
  prompt?: string;
  forkFrom?: string;
}

export const SessionCreateInputSchema: z.ZodType<SessionCreateInput> = z.object({
  cwd: z.string().min(1).optional().describe('Working directory for a new session. Defaults to the current session cwd.'),
  title: z.string().min(1).optional().describe('Optional title for the new session.'),
  prompt: z.string().min(1).optional().describe('Optional first task to submit to the new session.'),
  forkFrom: z.string().min(1).optional().describe('Optional source session id or exact title to fork with history.'),
});

export interface SessionListInput {
  filter?: string;
}

export const SessionListInputSchema: z.ZodType<SessionListInput> = z.object({
  filter: z
    .string()
    .optional()
    .describe('Optional case-insensitive substring matched against id, title, cwd, status, and dir.'),
});

export type SessionDeliveryStatus = 'started' | 'queued' | 'steered';
export type SessionListStatus = 'idle' | 'running' | 'queued' | 'archived';

export interface SessionListEntry {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly status: SessionListStatus;
  readonly dir: string;
}

export interface SessionMessageError {
  readonly code: string;
  readonly message: string;
  readonly candidates?: readonly SessionListEntry[];
}

export interface SessionMessageFailure {
  readonly status: 'error';
  readonly error: SessionMessageError;
}

export interface SessionSendSuccess {
  readonly messageId: string;
  readonly status: SessionDeliveryStatus;
}

export type SessionSendResult = SessionSendSuccess | SessionMessageFailure;

export interface SessionReadSuccess {
  readonly id: string;
  readonly title: string;
  readonly status: SessionListStatus;
  readonly latestAssistant?: string;
}

export type SessionReadResult = SessionReadSuccess | SessionMessageFailure;

export interface SessionCreateSuccess {
  readonly sessionId: string;
  readonly status: 'created';
  readonly promptId?: string;
  readonly promptStatus?: 'started' | 'queued';
}

export type SessionCreateResult = SessionCreateSuccess | SessionMessageFailure;

export interface ISessionMessageService {
  readonly _serviceBrand: undefined;
  send(input: SessionSendInput): Promise<SessionSendResult>;
  read(input: SessionReadInput): Promise<SessionReadResult>;
  create(input: SessionCreateInput): Promise<SessionCreateResult>;
  list(filter?: string): Promise<readonly SessionListEntry[]>;
}

export const ISessionMessageService = createDecorator<ISessionMessageService>('sessionMessageService');

export interface ISessionSendTool extends AgentTool<SessionSendInput> {
  readonly _serviceBrand: undefined;
}

export const ISessionSendTool = createDecorator<ISessionSendTool>('sessionSendTool');

export interface ISessionReadTool extends AgentTool<SessionReadInput> {
  readonly _serviceBrand: undefined;
}

export const ISessionReadTool = createDecorator<ISessionReadTool>('sessionReadTool');

export interface ISessionCreateTool extends AgentTool<SessionCreateInput> {
  readonly _serviceBrand: undefined;
}

export const ISessionCreateTool = createDecorator<ISessionCreateTool>('sessionCreateTool');

export interface ISessionListTool extends AgentTool<SessionListInput> {
  readonly _serviceBrand: undefined;
}

export const ISessionListTool = createDecorator<ISessionListTool>('sessionListTool');
