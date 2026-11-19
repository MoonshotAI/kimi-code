import { defineBrowserValidator } from './browser-validator';
import { Type, type Static } from 'typebox';
import { BrowserIdSchema as Id } from './browser-schema';
import { BrowserControllerSchema } from './browser-run';
const Tab = { tabId: Id };

const UiTab = Type.Object({ tabId: Id, browserId: Id }, { additionalProperties: false });
const NullableId = Type.Union([Id, Type.Null()]);
const UiStateFields = {
  turnId: NullableId, panelVisible: Type.Boolean(), activeTabId: NullableId, tabs: Type.Array(UiTab),
  workspaceRoot: Type.Optional(Type.Union([Type.String({ maxLength: 4096 }), Type.Null()])),
  permissionMode: Type.Optional(Type.Enum(['manual', 'auto', 'yolo'])),
  controlledController: Type.Optional(BrowserControllerSchema),
};
const UiState = Type.Union([
  Type.Object({ ...UiStateFields, controlledTabId: Type.Null(), controlledLeaseId: Type.Null() }),
  Type.Object({ ...UiStateFields, controlledTabId: Id, controlledLeaseId: Id }),
]);
const UiCommand = Type.Union([
  Type.Object({ action: Type.Literal('get_state') }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('activate_panel') }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('create_tab') }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('release_tab'), ...Tab, expectedLeaseId: Id }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('activate_tab'), ...Tab }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('switch_tab'), ...Tab }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal('close_tab'), ...Tab, expectedLeaseId: Id }, { additionalProperties: false }),
]);
const UiRequest = Type.Union([
  Type.Object({ requestId: Type.Integer({ minimum: 1 }), sessionId: Type.Optional(Id), controller: Type.Optional(BrowserControllerSchema), command: UiCommand }),
  Type.Object({ requestId: Type.Integer({ minimum: 1 }), cancel: Type.Literal(true) }, { additionalProperties: false }),
]);
const UiResponse = Type.Object({ requestId: Type.Integer({ minimum: 1 }), ok: Type.Boolean(), state: Type.Optional(UiState), error: Type.Optional(Type.String()) }, { additionalProperties: false });

export type BrowserUiTab = Static<typeof UiTab>;
export type BrowserUiState = Static<typeof UiState>;
export type BrowserUiCommand = Static<typeof UiCommand>;
export type BrowserUiRequest = Static<typeof UiRequest>;
export type BrowserUiCommandRequest = Exclude<BrowserUiRequest, { cancel: true }>;
export type BrowserUiResponse = Static<typeof UiResponse>;

export function isBrowserUiRequest(value: unknown): value is BrowserUiRequest {
  return browserValidators.UiRequest.Check(value);
}

export function isBrowserUiState(value: unknown): value is BrowserUiState {
  return browserValidators.UiState.Check(value);
}

export function isBrowserUiResponse(value: unknown): value is BrowserUiResponse {
  return browserValidators.UiResponse.Check(value);
}

export const browserValidators = {
  UiRequest: defineBrowserValidator(UiRequest),
  UiState: defineBrowserValidator(UiState),
  UiResponse: defineBrowserValidator(UiResponse),
};
