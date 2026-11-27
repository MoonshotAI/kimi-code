import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  getUiPreferencesResponseSchema,
  importUiPreferencesRequestSchema,
  importUiPreferencesResponseSchema,
  patchUiPreferencesRequestSchema,
  patchUiPreferencesResponseSchema,
  uiPreferencesActionParamSchema,
} from '../protocol/rest-ui-preferences';
import { UiPreferencesError } from '../services/uiPreferences/document';
import type { UiPreferencesStore } from '../services/uiPreferences/uiPreferencesStore';

type Handler = (
  req: { id: string; body: unknown; params: unknown },
  reply: { send(payload: unknown): unknown },
) => Promise<void> | void;

interface RouteOptions {
  preHandler: unknown[];
  schema?: Record<string, unknown>;
}

interface UiPreferencesRouteHost {
  get(path: string, options: RouteOptions, handler: Handler): unknown;
  patch(path: string, options: RouteOptions, handler: Handler): unknown;
  post(path: string, options: RouteOptions, handler: Handler): unknown;
}

const errors = {
  [ErrorCode.VALIDATION_FAILED]: {},
  [ErrorCode.UI_PREFERENCE_TYPE_MISMATCH]: {},
  [ErrorCode.UI_PREFERENCES_TOO_LARGE]: {},
  [ErrorCode.PERSISTENCE_FAILURE]: {},
};

async function respond(
  req: { id: string },
  reply: { send(payload: unknown): unknown },
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    reply.send(okEnvelope(await run(), req.id));
  } catch (error) {
    if (!(error instanceof UiPreferencesError)) throw error;
    reply.send(
      errEnvelope(error.code, error.message, req.id, error.key === undefined ? undefined : { key: error.key }),
    );
  }
}

export function registerUiPreferencesRoutes(
  app: UiPreferencesRouteHost,
  store: UiPreferencesStore,
): void {
  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/ui-preferences',
      success: { data: getUiPreferencesResponseSchema },
      errors: { [ErrorCode.PERSISTENCE_FAILURE]: {} },
      description:
        'Read the UI preferences shared by every client of this home',
      tags: ['ui-preferences'],
    },
    async (req, reply) => {
      await respond(req, reply, () => store.read());
    },
  );
  app.get(getRoute.path, getRoute.options, getRoute.handler as Handler);

  const patchRoute = defineRoute(
    {
      method: 'PATCH',
      path: '/ui-preferences',
      body: patchUiPreferencesRequestSchema,
      success: { data: patchUiPreferencesResponseSchema },
      errors,
      description:
        'Apply set / unset / add / remove / set_field / unset_field operations to UI preferences atomically; changes are broadcast as a ui_preferences global event',
      tags: ['ui-preferences'],
    },
    async (req, reply) => {
      await respond(req, reply, () => store.patch(req.body.ops, req.body.client_id));
    },
  );
  app.patch(patchRoute.path, patchRoute.options, patchRoute.handler as Handler);

  const actionRoute = defineRoute(
    {
      method: 'POST',
      path: '/ui-preferences:action',
      params: uiPreferencesActionParamSchema,
      body: importUiPreferencesRequestSchema,
      success: { data: importUiPreferencesResponseSchema },
      errors,
      description:
        'Use `:import` to merge preferences a client kept in local storage before this server stored them. Keys the user already changed here are skipped',
      tags: ['ui-preferences'],
      operationId: 'importUiPreferences',
    },
    async (req, reply) => {
      const raw = req.params.action;
      const action = raw.startsWith(':') ? raw.slice(1) : raw;
      if (action !== 'import') {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, `unsupported action: ${raw}`, req.id));
        return;
      }
      await respond(req, reply, () => store.import(req.body.values, req.body.client_id));
    },
  );
  app.post(actionRoute.path, actionRoute.options, actionRoute.handler as Handler);
}
