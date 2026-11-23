import { defineBrowserValidator } from './browser-validator';
import { Type, type Static } from 'typebox';
import { asBrowserFavicon, asBrowserBounds, BrowserBoundsSchema } from './browser';
import { parseBrowserAnnotationDetails, type BrowserAnnotationDetails } from './browser-annotation-details';
import { BrowserRequestIdSchema } from './browser-schema';

export const BROWSER_OVERLAY_GUTTER = 12;
const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9:_.-]+$' });
const IconName = Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9:_.-]+$' });
const Icon = Type.Optional(IconName);
const Label = Type.String({ minLength: 1, maxLength: 256 });
const OptionalFlag = Type.Optional(Type.Boolean());
const Placement = Type.Enum(['bottom-start', 'bottom-end', 'top-start', 'top-end']);
const InitialFocus = Type.Enum(['none', 'first-item']);
const Viewport = Type.Object({ width: Type.Number({ minimum: 1, maximum: 16384 }), height: Type.Number({ minimum: 1, maximum: 16384 }) }, { additionalProperties: false });
const ItemAction = Type.Object({ id: Id, label: Label, icon: IconName, keepOpen: OptionalFlag });
const ItemProgress = Type.Object({ label: Label, value: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), paused: OptionalFlag });
const TextRange = Type.Object({ start: Type.Integer({ minimum: 0 }), end: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
const MenuItem = Type.Union([
  Type.Object({ kind: Type.Literal('separator') }),
  Type.Object({ kind: Type.Enum(['section', 'note']), id: Id, label: Type.String({ maxLength: 1024 }) }),
  Type.Object({ kind: Type.Literal('choices'), id: Id, label: Type.String({ maxLength: 1024 }), icon: Icon, value: Type.String(), options: Type.Array(Type.Object({ id: Id, label: Type.String({ maxLength: 256 }) }), { minItems: 1, maxItems: 8 }),
    disabled: OptionalFlag, notice: Type.Optional(Type.Object({ message: Type.String({ maxLength: 256 }), linkLabel: Type.String({ maxLength: 64 }), action: Id })) }),
  Type.Object({ kind: Type.Literal('zoom'), id: Id, label: Label, icon: Icon, value: Label,
    decreaseAction: Id, decreaseLabel: Label, increaseAction: Id, increaseLabel: Label, resetAction: Id, resetLabel: Label,
    decreaseDisabled: OptionalFlag, increaseDisabled: OptionalFlag, resetDisabled: OptionalFlag }),
  Type.Object({ kind: Type.Literal('item'), id: Id, label: Label, icon: Icon,
    favicon: Type.Optional(Type.String()), shortcut: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 24 }), { maxItems: 8 })),
    disabled: OptionalFlag, selected: OptionalFlag, danger: OptionalFlag, starred: OptionalFlag, keepOpen: OptionalFlag,
    labelRanges: Type.Optional(Type.Array(TextRange, { maxItems: 64 })), descriptionRanges: Type.Optional(Type.Array(TextRange, { maxItems: 64 })),
    metrics: Type.Optional(Type.Array(Type.Object({ label: Label, value: Label }), { maxItems: 4 })), description: Type.Optional(Type.String({ maxLength: 1024 })), detail: Type.Optional(Type.String({ maxLength: 1024 })), tone: Type.Optional(Type.Enum(['warning', 'danger'])),
    actions: Type.Optional(Type.Array(ItemAction, { maxItems: 4 })), progress: Type.Optional(ItemProgress) }),
]);
const MenuFields = {
  menuId: Id, anchor: BrowserBoundsSchema, placement: Type.Optional(Placement), initialFocus: Type.Optional(InitialFocus),
  offset: Type.Optional(Type.Number({ minimum: -16, maximum: 32 })), width: Type.Optional(Type.Number({ minimum: 180 })),
  autoWidth: OptionalFlag, preserveFocus: OptionalFlag, items: Type.Array(MenuItem, { minItems: 1, maxItems: 2048 }),
  footerStart: Type.Optional(Type.Integer({ minimum: 0 })), query: Type.Optional(Type.String({ maxLength: 1024 })),
};
export const BrowserOverlayMenuRequestSchema = Type.Object({ ...MenuFields, refresh: OptionalFlag });
const DialogCoordinate = Type.Number({ minimum: 0, maximum: 32768 });
const DialogBounds = Type.Object({ x: DialogCoordinate, y: DialogCoordinate, width: DialogCoordinate, height: DialogCoordinate });
const DialogFields = {
  preserveFocus: OptionalFlag, dismissible: OptionalFlag,
  dialogId: Id, title: Label, message: Type.Optional(Type.String({ maxLength: 4096 })),
  confirmLabel: Type.String({ minLength: 1, maxLength: 128 }), cancelLabel: Type.String({ minLength: 1, maxLength: 128 }), closeLabel: Type.String({ minLength: 1, maxLength: 128 }),
  variant: Type.Optional(Type.Enum(['primary', 'danger'])), loading: OptionalFlag, initialFocus: Type.Optional(Type.Enum(['confirm', 'cancel'])), anchor: Type.Optional(DialogBounds), boundary: Type.Optional(DialogBounds),
  annotation: Type.Optional(Type.Unknown()), viewport: Type.Optional(Viewport),
  input: Type.Optional(Type.Object({ label: Type.String({ maxLength: 256 }), value: Type.String({ maxLength: 10000 }), placeholder: Type.Optional(Type.String({ maxLength: 256 })), readOnly: OptionalFlag, singleLine: OptionalFlag })),
  checkbox: Type.Optional(Type.Object({ label: Type.String({ maxLength: 256 }), checked: Type.Boolean(), disabled: OptionalFlag })),
  preview: Type.Optional(Type.Object({ src: Type.String({ maxLength: 4 * 1024 * 1024, pattern: '^data:image/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' }), alt: Type.String({ maxLength: 1024 }) })),
  auxiliary: Type.Optional(Type.Object({ label: Type.String({ maxLength: 256 }), disabled: OptionalFlag })),
  agent: Type.Optional(Type.Object({ label: Label, hint: Type.String({ maxLength: 512 }), chosen: OptionalFlag }, { additionalProperties: false })),
  singleAction: OptionalFlag,
  files: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 32 })),
};
const DialogInput = Type.Object({ ...DialogFields, kind: Type.Optional(Type.Unknown()), requestId: Type.Optional(Type.Unknown()) }, { additionalProperties: false });
export const BrowserOverlayDialogRequestSchema = Type.Object(DialogFields, { additionalProperties: false });
const Rendered = Type.Object({ requestId: BrowserRequestIdSchema, ...Viewport.properties });
const Visibility = Type.Object({ requestId: BrowserRequestIdSchema });
const Activate = Type.Object({ ...Visibility.properties, itemId: Id }, { additionalProperties: false });
const DialogKind = Type.Object({ kind: Type.Literal('dialog') });
const Dismiss = Type.Object({ ...Visibility.properties, reason: Type.Enum(['dismiss', 'escape']) }, { additionalProperties: false });

export type BrowserOverlayPlacement = Static<typeof Placement>;
export type BrowserOverlayInitialFocus = Static<typeof InitialFocus>;
export type BrowserOverlayAnchor = Static<typeof BrowserBoundsSchema>;
export type BrowserOverlayMenuItem = Static<typeof MenuItem>;
export type BrowserOverlayMenuRequest = Static<typeof BrowserOverlayMenuRequestSchema>;
export type BrowserOverlayDialogRequest = Omit<Static<typeof BrowserOverlayDialogRequestSchema>, 'annotation'> & { annotation?: BrowserAnnotationDetails };
export type BrowserOverlayDialogVariant = NonNullable<BrowserOverlayDialogRequest['variant']>;
export type BrowserOverlayViewport = Static<typeof Viewport>;
export type BrowserOverlayRendered = Static<typeof Rendered>;
export type BrowserOverlayVisibilityRequest = Static<typeof Visibility>;
export type BrowserOverlayActivateRequest = Static<typeof Activate>;
export type BrowserOverlayDismissRequest = Static<typeof Dismiss>;

const MenuConfig = Type.Object({
  ...MenuFields, kind: Type.Literal('menu'), requestId: BrowserRequestIdSchema,
  width: Type.Optional(Type.Number({ minimum: 1 })),
  minWidth: Type.Optional(Type.Number({ minimum: 1 })), maxHeight: Type.Optional(Type.Number({ minimum: 1 })),
});
const Shown = Type.Object({ requestId: BrowserRequestIdSchema, placement: Type.Optional(Placement) });
const Action = Type.Object({ menuId: Id, itemId: Id, keepOpen: OptionalFlag });
const CloseReason = Type.Enum(['action', 'dismiss', 'escape', 'replaced', 'window-blur', 'window-move', 'window-resize', 'host-closed', 'programmatic']);
const Closed = Type.Object({ menuId: Id, reason: CloseReason });
const DialogActionFields = {
  action: Type.Enum(['confirm', 'cancel', 'auxiliary']),
  value: Type.String({ maxLength: 10000 }), checked: OptionalFlag,
};
const DialogAction = Type.Object({ ...DialogActionFields, dialogId: Id, value: Type.Optional(DialogActionFields.value) });
const FormAction = Type.Object({ ...DialogActionFields, requestId: BrowserRequestIdSchema });
const DialogClosed = Type.Object({ dialogId: Id, reason: CloseReason });

export type BrowserOverlayMenuConfig = Static<typeof MenuConfig>;
export interface BrowserOverlayDialogConfig extends BrowserOverlayDialogRequest {
  kind: 'dialog';
  requestId: number;
}
export type BrowserOverlayConfig = BrowserOverlayMenuConfig | BrowserOverlayDialogConfig;
export type BrowserOverlayShown = Static<typeof Shown>;
export type BrowserOverlayAction = Static<typeof Action>;
export type BrowserOverlayCloseReason = Static<typeof CloseReason>;
export type BrowserOverlayClosed = Static<typeof Closed>;
export type BrowserOverlayDialogAction = Static<typeof DialogAction>;
export type BrowserOverlayFormAction = Static<typeof FormAction>;
export type BrowserOverlayDialogClosed = Static<typeof DialogClosed>;

export function isBrowserOverlayConfig(value: unknown): value is BrowserOverlayConfig {
  return browserValidators.MenuConfig.Check(value) || asBrowserOverlayDialogConfig(value) !== null;
}

export function isBrowserOverlayShown(value: unknown): value is BrowserOverlayShown {
  return browserValidators.Shown.Check(value);
}

export function isBrowserOverlayAction(value: unknown): value is BrowserOverlayAction {
  return browserValidators.Action.Check(value);
}

export function isBrowserOverlayClosed(value: unknown): value is BrowserOverlayClosed {
  return browserValidators.Closed.Check(value);
}

export function isBrowserOverlayDialogAction(value: unknown): value is BrowserOverlayDialogAction {
  return browserValidators.DialogAction.Check(value);
}

export function isBrowserOverlayDialogClosed(value: unknown): value is BrowserOverlayDialogClosed {
  return browserValidators.DialogClosed.Check(value);
}

export function asBrowserOverlayFormAction(value: unknown): BrowserOverlayFormAction | null {
  return browserValidators.FormAction.Parse(value);
}

export function asBrowserOverlayMenuId(value: unknown): string | null {
  return browserValidators.Id.Check(value) ? value : null;
}

export function asBrowserOverlayAnchor(value: unknown): BrowserOverlayAnchor | null {
  return asBrowserBounds(value);
}

function asMenuItem(value: unknown): BrowserOverlayMenuItem | null {
  const validator = [browserValidators.menuItem0, browserValidators.menuItem1, browserValidators.menuItem2, browserValidators.menuItem3, browserValidators.menuItem4].find(branch => branch.Check(value));
  if (validator === undefined) return null;
  const item = validator.Parse(value)!;
  if (item.kind === 'choices') {
    item.options = item.options.map(({ id, label }) => ({ id, label }));
    if (new Set(item.options.map(option => option.id)).size !== item.options.length) return null;
    if (item.value !== '' && !item.options.some(option => option.id === item.value)) return null;
    if (item.disabled !== true) delete item.disabled;
    if (item.notice !== undefined) item.notice = { message: item.notice.message, linkLabel: item.notice.linkLabel, action: item.notice.action };
  }
  if (item.kind === 'zoom') {
    if (item.decreaseDisabled !== true) delete item.decreaseDisabled;
    if (item.increaseDisabled !== true) delete item.increaseDisabled;
    if (item.resetDisabled !== true) delete item.resetDisabled;
  }
  if (item.kind === 'item') {
    if (item.shortcut !== undefined) item.shortcut = [...item.shortcut];
    if (item.favicon !== undefined && asBrowserFavicon(item.favicon) === null) return null;
    if (item.disabled !== true) delete item.disabled;
    if (item.danger !== true) delete item.danger;
    if (item.starred !== true) delete item.starred;
    if (item.keepOpen !== true) delete item.keepOpen;
    if (item.actions !== undefined) item.actions = item.actions.map(({ id, label, icon, keepOpen }) => ({ id, label, icon, ...(keepOpen === true ? { keepOpen: true } : {}) }));
    if (item.progress !== undefined) item.progress = { label: item.progress.label, ...(item.progress.value === undefined ? {} : { value: item.progress.value }), ...(item.progress.paused === true ? { paused: true } : {}) };
  }
  return item;
}

export function asBrowserOverlayMenuRequest(value: unknown): BrowserOverlayMenuRequest | null {
  const request = browserValidators.BrowserOverlayMenuRequestSchema.Parse(value);
  if (request === null) return null;
  const anchor = asBrowserBounds(request.anchor)!;
  if (request.width !== undefined && request.width > Math.max(640, request.preserveFocus === true ? Math.ceil(anchor.width) : 0)) return null;
  if (request.footerStart !== undefined && request.footerStart > request.items.length) return null;
  const items: BrowserOverlayMenuItem[] = [];
  const ids = new Set<string>();
  for (const raw of request.items) {
    const item = asMenuItem(raw);
    if (item === null) return null;
    if (item.kind !== 'separator') {
      const itemIds = item.kind === 'zoom' ? [item.id, item.decreaseAction, item.increaseAction, item.resetAction]
        : item.kind === 'choices' ? [item.id, ...item.options.map(option => option.id), ...(item.notice === undefined ? [] : [item.notice.action])]
          : item.kind === 'item' ? [item.id, ...(item.actions ?? []).map(action => action.id)] : [item.id];
      if (new Set(itemIds).size !== itemIds.length) return null;
      if (itemIds.some(id => ids.has(id))) return null;
      for (const id of itemIds) ids.add(id);
    }
    items.push(item);
  }
  if (items.every(item => item.kind === 'separator')) return null;
  return {
    menuId: request.menuId, anchor, items, placement: request.placement ?? 'bottom-end',
    offset: Math.round(request.offset ?? 4), width: Math.round(request.width ?? 220),
    ...(request.refresh === true ? { refresh: true } : {}),
    ...(request.initialFocus === undefined ? {} : { initialFocus: request.initialFocus }),
    ...(request.autoWidth === true ? { autoWidth: true } : {}),
    ...(request.preserveFocus === true ? { preserveFocus: true } : {}),
    ...(request.footerStart === undefined ? {} : { footerStart: request.footerStart }),
    ...(request.query ? { query: request.query } : {}),
  };
}

export function asBrowserOverlayDialogRequest(value: unknown): BrowserOverlayDialogRequest | null {
  const input = browserValidators.DialogInput.Parse(value);
  if (input === null) return null;
  const annotation = input.annotation === undefined ? undefined : parseBrowserAnnotationDetails(input.annotation);
  if (annotation === null) return null;
  return {
    ...(input.preserveFocus === undefined ? {} : { preserveFocus: input.preserveFocus }),
    ...(input.dismissible === undefined ? {} : { dismissible: input.dismissible }),
    dialogId: input.dialogId, title: input.title, confirmLabel: input.confirmLabel, cancelLabel: input.cancelLabel, closeLabel: input.closeLabel,
    anchor: input.anchor === undefined ? undefined : asBrowserBounds(input.anchor)!,
    ...(input.boundary === undefined ? {} : { boundary: asBrowserBounds(input.boundary)! }),
    ...(annotation === undefined ? {} : { annotation }),
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.input === undefined ? {} : { input: { label: input.input.label, value: input.input.value, placeholder: input.input.placeholder, readOnly: input.input.readOnly, singleLine: input.input.singleLine } }),
    ...(input.checkbox === undefined ? {} : { checkbox: { label: input.checkbox.label, checked: input.checkbox.checked, disabled: input.checkbox.disabled } }),
    ...(input.preview === undefined ? {} : { preview: { src: input.preview.src, alt: input.preview.alt } }),
    ...(input.auxiliary === undefined ? {} : { auxiliary: { label: input.auxiliary.label, disabled: input.auxiliary.disabled } }),
    ...(input.agent === undefined ? {} : { agent: { label: input.agent.label, hint: input.agent.hint, ...(input.agent.chosen === true ? { chosen: true } : {}) } }),
    ...(input.singleAction === true ? { singleAction: true } : {}),
    ...(input.files === undefined ? {} : { files: [...input.files] }),
    variant: input.variant === 'primary' ? 'primary' : 'danger',
    ...(input.loading === true ? { loading: true } : {}),
    ...(input.initialFocus === undefined ? {} : { initialFocus: input.initialFocus }),
    ...(input.viewport === undefined ? {} : { viewport: { width: Math.round(input.viewport.width), height: Math.round(input.viewport.height) } }),
  };
}

export function asBrowserOverlayRendered(value: unknown): BrowserOverlayRendered | null {
  const rendered = browserValidators.Rendered.Parse(value);
  return rendered === null ? null : { requestId: rendered.requestId, width: Math.ceil(rendered.width), height: Math.ceil(rendered.height) };
}

export function asBrowserOverlayVisibilityRequest(value: unknown): BrowserOverlayVisibilityRequest | null {
  return browserValidators.Visibility.Parse(value);
}

export function asBrowserOverlayDialogConfig(value: unknown): BrowserOverlayDialogConfig | null {
  if (!browserValidators.DialogKind.Check(value)) return null;
  const visibility = asBrowserOverlayVisibilityRequest(value);
  const dialog = asBrowserOverlayDialogRequest(value);
  return visibility === null || dialog === null ? null : { ...dialog, kind: 'dialog', requestId: visibility.requestId };
}

export function asBrowserOverlayActivateRequest(value: unknown): BrowserOverlayActivateRequest | null {
  return browserValidators.Activate.Parse(value);
}

export function asBrowserOverlayDismissRequest(value: unknown): BrowserOverlayDismissRequest | null {
  return browserValidators.Dismiss.Parse(value);
}

export const browserValidators = {
  MenuConfig: defineBrowserValidator(MenuConfig),
  Shown: defineBrowserValidator(Shown),
  Action: defineBrowserValidator(Action),
  Closed: defineBrowserValidator(Closed),
  DialogAction: defineBrowserValidator(DialogAction),
  DialogClosed: defineBrowserValidator(DialogClosed),
  FormAction: defineBrowserValidator(FormAction),
  Id: defineBrowserValidator(Id),
  BrowserOverlayMenuRequestSchema: defineBrowserValidator(BrowserOverlayMenuRequestSchema),
  DialogInput: defineBrowserValidator(DialogInput),
  Rendered: defineBrowserValidator(Rendered),
  Visibility: defineBrowserValidator(Visibility),
  DialogKind: defineBrowserValidator(DialogKind),
  Activate: defineBrowserValidator(Activate),
  Dismiss: defineBrowserValidator(Dismiss),
  menuItem0: defineBrowserValidator(MenuItem.anyOf[0]),
  menuItem1: defineBrowserValidator(MenuItem.anyOf[1]),
  menuItem2: defineBrowserValidator(MenuItem.anyOf[2]),
  menuItem3: defineBrowserValidator(MenuItem.anyOf[3]),
  menuItem4: defineBrowserValidator(MenuItem.anyOf[4]),
};
