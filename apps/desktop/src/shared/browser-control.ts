import { defineBrowserValidator } from './browser-validator';
import { Type, type Static } from 'typebox';
import { BrowserIdSchema } from './browser-schema';
import { BROWSER_DIALOG_RECORD_ANSWERERS, BROWSER_DIALOG_RECORD_KINDS, BROWSER_DIALOG_RECORD_OUTCOMES, BrowserDialogRecordsSchema } from './browser-dialogs';
import { BrowserControllerSchema, BrowserSubagentRunSchema } from './browser-run';

export const BrowserControlPresentationSchema = Type.Object({
  browserId: BrowserIdSchema, sessionId: BrowserIdSchema,
  turnId: Type.Union([BrowserIdSchema, Type.Null()]),
  status: Type.Enum(['running', 'paused', 'unknown', 'idle']),
  controller: Type.Optional(BrowserControllerSchema),
});
const Label = Type.String({ maxLength: 500 });
export const BROWSER_CONTROL_ACTIVITIES = [
  'reading', 'inspecting', 'capturing', 'clicking', 'hovering', 'typing', 'pressing',
  'selecting', 'checking', 'scrolling', 'dragging', 'navigating', 'waiting', 'answering',
] as const;
export type BrowserControlActivityKind = typeof BROWSER_CONTROL_ACTIVITIES[number];
const BrowserControlActivityLabelsSchema = Type.Object(
  Object.fromEntries(BROWSER_CONTROL_ACTIVITIES.map(name => [name, Label])) as Record<BrowserControlActivityKind, typeof Label>,
);
function labelsFor<const T extends readonly string[]>(names: T) {
  return Type.Object(Object.fromEntries(names.map(name => [name, Label])) as Record<T[number], typeof Label>);
}
export const BrowserControlDialogLabelsSchema = Type.Object({
  button: Label, title: Label, answeredBy: Label, showInFolder: Label, move: Label,
  kinds: labelsFor(BROWSER_DIALOG_RECORD_KINDS), outcomes: labelsFor(BROWSER_DIALOG_RECORD_OUTCOMES), answerers: labelsFor(BROWSER_DIALOG_RECORD_ANSWERERS),
});
export const BrowserControlLabelsSchema = Type.Object({
  running: Type.String({ maxLength: 500 }), elapsed: Type.String({ maxLength: 500 }),
  takeover: Type.String({ maxLength: 500 }), takeoverHint: Type.String({ maxLength: 500 }),
  pointer: Type.String({ maxLength: 500 }), typing: Type.String({ maxLength: 500 }),
  key: Type.String({ maxLength: 500 }), scrolling: Type.String({ maxLength: 500 }),
  activityTarget: Label, activities: BrowserControlActivityLabelsSchema,
  dialogs: Type.Optional(BrowserControlDialogLabelsSchema),
});
export const BrowserControlConfigSchema = Type.Object({
  controls: Type.Array(BrowserControlPresentationSchema, { maxItems: 1000 }),
  labels: BrowserControlLabelsSchema, colorScheme: Type.Enum(['light', 'dark']), reducedMotion: Type.Boolean(),
});
export const BrowserControlOwnershipSchema = Type.Object({
  sessionIds: Type.Array(BrowserIdSchema),
  runs: Type.Array(Type.Object({ sessionId: BrowserIdSchema, run: BrowserSubagentRunSchema })),
  browserIds: Type.Array(BrowserIdSchema),
});
export type BrowserControlPresentation = Static<typeof BrowserControlPresentationSchema>;
export type BrowserControlLabels = Static<typeof BrowserControlLabelsSchema>;
export type BrowserControlDialogLabels = Static<typeof BrowserControlDialogLabelsSchema>;
export type BrowserControlConfig = Static<typeof BrowserControlConfigSchema>;
export type BrowserControlOwnership = Static<typeof BrowserControlOwnershipSchema>;

const Revision = Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
const Radius = Type.Number({ minimum: 0, maximum: 64 });
const BrowserControlSurfaceSchema = Type.Object({
  browserId: BrowserIdSchema, revision: Revision, startedAt: Type.Number(), labels: BrowserControlLabelsSchema,
  controller: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  colorScheme: Type.Enum(['light', 'dark']), reducedMotion: Type.Boolean(),
  corners: Type.Tuple([Radius, Radius, Radius, Radius]),
  insets: Type.Tuple([Radius, Radius, Radius, Radius]),
});
const BrowserControlPointerSchema = Type.Object({
  browserId: BrowserIdSchema, revision: Revision,
  kind: Type.Enum(['move', 'down', 'up', 'type', 'key', 'scroll', 'reset', 'blocked']),
  x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), drag: Type.Optional(Type.Boolean()),
});
const BrowserControlActivitySchema = Type.Object({
  browserId: BrowserIdSchema, revision: Revision,
  id: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  activity: Type.Union([Type.Enum([...BROWSER_CONTROL_ACTIVITIES]), Type.Null()]),
  scan: Type.Optional(Type.Boolean()), target: Type.Optional(Type.String({ maxLength: 80 })),
  rect: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number(), width: Type.Number(), height: Type.Number() })),
});
const BrowserControlTakeoverSchema = Type.Object({ browserId: BrowserIdSchema, revision: Revision });
const BrowserControlDialogsSchema = Type.Object({ browserId: BrowserIdSchema, revision: Revision, records: BrowserDialogRecordsSchema });
const BrowserControlDownloadActionSchema = Type.Object({ browserId: BrowserIdSchema, revision: Revision, recordId: BrowserIdSchema, action: Type.Enum(['show', 'move']) }, { additionalProperties: false });
export type BrowserControlSurface = Static<typeof BrowserControlSurfaceSchema>;
export type BrowserControlPointer = Static<typeof BrowserControlPointerSchema>;
export type BrowserControlActivity = Static<typeof BrowserControlActivitySchema>;
export type BrowserControlDialogs = Static<typeof BrowserControlDialogsSchema>;
export type BrowserControlDownloadAction = Static<typeof BrowserControlDownloadActionSchema>;

export interface BrowserControlSurfaceBridge {
  ready: () => void;
  takeOver: (browserId: string, revision: number) => void;
  downloadAction: (action: BrowserControlDownloadAction) => void;
  onDialogs: (cb: (dialogs: BrowserControlDialogs) => void) => () => void;
  onSurface: (cb: (surface: BrowserControlSurface | null) => void) => () => void;
  onPointer: (cb: (pointer: BrowserControlPointer) => void) => () => void;
  onActivity: (cb: (activity: BrowserControlActivity) => void) => () => void;
  onResizing: (cb: () => void) => () => void;
}

export function isBrowserControlConfig(value: unknown): value is BrowserControlConfig {
  return browserValidators.BrowserControlConfigSchema.Check(value);
}

export function isBrowserControlOwnership(value: unknown): value is BrowserControlOwnership {
  return browserValidators.BrowserControlOwnershipSchema.Check(value);
}

export function browserControlDuration(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export const browserValidators = {
  surface: defineBrowserValidator(Type.Union([BrowserControlSurfaceSchema, Type.Null()])),
  pointer: defineBrowserValidator(BrowserControlPointerSchema),
  activity: defineBrowserValidator(BrowserControlActivitySchema),
  takeover: defineBrowserValidator(BrowserControlTakeoverSchema),
  dialogs: defineBrowserValidator(BrowserControlDialogsSchema),
  downloadAction: defineBrowserValidator(BrowserControlDownloadActionSchema),
  BrowserControlConfigSchema: defineBrowserValidator(BrowserControlConfigSchema),
  BrowserControlOwnershipSchema: defineBrowserValidator(BrowserControlOwnershipSchema),
  subagentRun: defineBrowserValidator(BrowserSubagentRunSchema),
};
