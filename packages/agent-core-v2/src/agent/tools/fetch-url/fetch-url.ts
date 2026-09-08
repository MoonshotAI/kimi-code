import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const FetchURLInputSchema = z.object({
  url: z.string().describe('The URL to fetch content from.'),
});

export type FetchURLInput = z.infer<typeof FetchURLInputSchema>;

export interface IFetchURLTool extends AgentTool<FetchURLInput> {
  readonly _serviceBrand: undefined;
}
export const IFetchURLTool = createDecorator<IFetchURLTool>('fetchURLTool');
