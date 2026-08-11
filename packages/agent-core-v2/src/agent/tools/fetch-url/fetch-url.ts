/**
 * `tools` domain — `IFetchURLTool` contract.
 *
 * Public contract of FetchURL, the model's URL content fetcher. Only
 * fully-formed public `http`/`https` URLs are supported. The tool receives
 * the App-scope `IWebFetchService` via DI.
 *
 * Owns the `FetchURLInput` zod schema and the Agent-scope service identifier.
 * Bound at Agent scope.
 */

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
