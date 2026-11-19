import { defineBrowserValidator } from './browser-validator';
import { Type, type Static } from 'typebox';
import { BrowserIdSchema } from './browser-schema';

export const BROWSER_PAGE_DIALOG_KINDS = ['alert', 'confirm', 'prompt', 'beforeunload', 'file', 'upload', 'download'] as const;
export const BROWSER_PAGE_DIALOG_MESSAGE_MAX = 4096;
export const BROWSER_PAGE_DIALOG_FILES_MAX = 32;
export const BROWSER_PAGE_DIALOG_TEXT_MAX = 10000;

const Path = Type.String({ maxLength: 4096 });
export const BrowserPageDialogSchema = Type.Object({
  dialogId: BrowserIdSchema,
  browserId: BrowserIdSchema,
  kind: Type.Enum(BROWSER_PAGE_DIALOG_KINDS),
  origin: Type.String({ maxLength: 32768 }),
  message: Type.String({ maxLength: BROWSER_PAGE_DIALOG_MESSAGE_MAX }),
  defaultValue: Type.Optional(Type.String({ maxLength: BROWSER_PAGE_DIALOG_TEXT_MAX })),
  answerer: Type.Enum(['agent', 'user']),
  accept: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { maxItems: 64 })),
  multiple: Type.Optional(Type.Boolean()),
  files: Type.Optional(Type.Array(Path, { maxItems: BROWSER_PAGE_DIALOG_FILES_MAX })),
  target: Type.Optional(Type.String({ maxLength: 32768 })),
  repeat: Type.Optional(Type.Enum(['form', 'action'])),
  agentChoice: Type.Optional(Type.Enum(['accepted', 'dismissed'])),
}, { additionalProperties: false });
export const BrowserPageDialogsSchema = Type.Array(BrowserPageDialogSchema, { maxItems: 64 });
export const BrowserPageDialogAnswerSchema = Type.Object({ dialogId: BrowserIdSchema, accept: Type.Boolean(), text: Type.Optional(Type.String({ maxLength: BROWSER_PAGE_DIALOG_TEXT_MAX })) }, { additionalProperties: false });

export const BROWSER_DIALOG_RECORD_KINDS = [...BROWSER_PAGE_DIALOG_KINDS, 'external-app', 'print', 'screen-capture', 'bluetooth', 'file-picker'] as const;
export const BROWSER_DIALOG_RECORD_OUTCOMES = ['accepted', 'dismissed', 'left', 'stayed', 'uploaded', 'saved', 'denied', 'timed-out', 'cancelled', 'blocked', 'too-large'] as const;
export const BROWSER_DIALOG_RECORD_ANSWERERS = ['agent', 'user', 'auto'] as const;
export const BROWSER_DIALOG_RECORD_MESSAGE_MAX = 512;
export const BROWSER_DIALOG_HISTORY_MAX = 50;

export const BrowserDialogRecordSchema = Type.Object({
  id: BrowserIdSchema,
  kind: Type.Enum(BROWSER_DIALOG_RECORD_KINDS),
  origin: Type.String({ maxLength: 2048 }),
  message: Type.Optional(Type.String({ maxLength: BROWSER_DIALOG_RECORD_MESSAGE_MAX })),
  text: Type.Optional(Type.String({ maxLength: BROWSER_DIALOG_RECORD_MESSAGE_MAX })),
  outcome: Type.Enum(BROWSER_DIALOG_RECORD_OUTCOMES),
  answerer: Type.Enum(BROWSER_DIALOG_RECORD_ANSWERERS),
  openedAt: Type.Number(),
  settledAt: Type.Number(),
  files: Type.Optional(Type.Array(Path, { maxItems: BROWSER_PAGE_DIALOG_FILES_MAX })),
  downloadId: Type.Optional(BrowserIdSchema),
}, { additionalProperties: false });
export const BrowserDialogRecordsSchema = Type.Array(BrowserDialogRecordSchema, { maxItems: BROWSER_DIALOG_HISTORY_MAX });

export type BrowserPageDialogKind = typeof BROWSER_PAGE_DIALOG_KINDS[number];
export type BrowserDialogRecordKind = typeof BROWSER_DIALOG_RECORD_KINDS[number];
export type BrowserDialogRecordOutcome = typeof BROWSER_DIALOG_RECORD_OUTCOMES[number];
export type BrowserDialogRecord = Static<typeof BrowserDialogRecordSchema>;

export interface BrowserPendingDialog {
  dialogId: string;
  tabId: string;
  kind: BrowserPageDialogKind;
  origin: string;
  message: string;
  defaultValue?: string;
  answerer: 'agent' | 'user';
  accept?: string[];
  multiple?: boolean;
  files?: string[];
  target?: string;
  retryAfterAccept?: true;
  ageMs: number;
}
export type BrowserPageDialog = Static<typeof BrowserPageDialogSchema>;
export type BrowserPageDialogAnswer = Static<typeof BrowserPageDialogAnswerSchema>;

export const browserValidators = {
  BrowserPageDialogsSchema: defineBrowserValidator(BrowserPageDialogsSchema),
  BrowserPageDialogAnswerSchema: defineBrowserValidator(BrowserPageDialogAnswerSchema),
};
