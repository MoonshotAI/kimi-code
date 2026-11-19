import { Type, type Static } from 'typebox';
import { BrowserIdSchema } from './browser-schema';
import { defineBrowserValidator } from './browser-validator';

const RunNumber = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const BrowserSubagentRunSchema = Type.Object({
  agentId: BrowserIdSchema,
  generation: RunNumber,
  turnId: RunNumber,
}, { additionalProperties: false });
export const BrowserControllerSchema = Type.Object({
  run: BrowserSubagentRunSchema,
  profile: Type.Optional(Type.String({ maxLength: 500 })),
  description: Type.Optional(Type.String({ maxLength: 500 })),
}, { additionalProperties: false });

export type BrowserSubagentRun = Static<typeof BrowserSubagentRunSchema>;
export type BrowserController = Static<typeof BrowserControllerSchema>;

export function sameBrowserSubagentRun(a: BrowserSubagentRun, b: BrowserSubagentRun): boolean {
  return a.agentId === b.agentId && a.generation === b.generation && a.turnId === b.turnId;
}

export function browserControllerLabel(controller: BrowserController): string {
  const profile = controller.profile?.trim();
  const description = controller.description?.trim();
  if (profile && description) return `${profile} · ${description}`;
  return profile || description || controller.run.agentId;
}

export const browserValidators = {
  run: defineBrowserValidator(BrowserSubagentRunSchema),
  controller: defineBrowserValidator(BrowserControllerSchema),
};
