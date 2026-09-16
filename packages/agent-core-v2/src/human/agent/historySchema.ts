import { z } from 'zod';

import type { SystemMessage, UserMessage } from '#/llm/message';

import type { HistoryMessage, SystemEntry, UserEntry } from './turn';

export const systemMessageSchema = z.custom<SystemMessage>();
export const userMessageSchema = z.custom<UserMessage>();
export const systemEntrySchema = z.custom<SystemEntry>();
export const userEntrySchema = z.custom<UserEntry>();
export const historyMessageSchema = z.custom<HistoryMessage>();
