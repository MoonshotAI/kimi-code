import { Type } from 'typebox';
import type { QuickModelMenuPayload } from '@moonshot-ai/app-core/quick-model-menu';
import { defineBrowserValidator } from './browser-validator';

const QuickModel = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 512 }),
  provider: Type.String({ minLength: 1, maxLength: 256 }),
  model: Type.String({ minLength: 1, maxLength: 512 }),
  displayName: Type.Optional(Type.String({ maxLength: 512 })),
  maxContextSize: Type.Number({ minimum: 0 }),
  capabilities: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 })),
  supportEfforts: Type.Optional(Type.Array(Type.String({ maxLength: 32 }), { maxItems: 16 })),
  defaultEffort: Type.Optional(Type.String({ maxLength: 32 })),
}, { additionalProperties: false });

const QuickModelMenuPayloadSchema = Type.Object({
  models: Type.Array(QuickModel, { maxItems: 2048 }),
  recentModels: Type.Array(QuickModel, { maxItems: 5 }),
  providerModels: Type.Array(QuickModel, { maxItems: 2048 }),
  providers: Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 256 }), label: Type.String({ maxLength: 256 }) }, { additionalProperties: false }), { maxItems: 256 }),
  activeProvider: Type.String({ maxLength: 256 }),
  activeProviderLabel: Type.String({ maxLength: 256 }),
  currentModelId: Type.Optional(Type.String({ maxLength: 512 })),
  currentEffort: Type.Optional(Type.String({ maxLength: 32 })),
  effortDescriptions: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 32 }), Type.String({ maxLength: 1024 }))),
}, { additionalProperties: false });

export const browserValidators = {
  QuickModelMenuPayload: defineBrowserValidator(QuickModelMenuPayloadSchema),
};

export function asQuickModelMenuPayload(value: unknown): QuickModelMenuPayload | null {
  return browserValidators.QuickModelMenuPayload.Parse(value);
}
