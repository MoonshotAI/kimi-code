import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const MonitorListInputSchema = z.object({});

export type MonitorListInput = z.infer<typeof MonitorListInputSchema>;

export interface IMonitorListTool extends AgentTool<MonitorListInput> { readonly _serviceBrand: undefined }
export const IMonitorListTool = createDecorator<IMonitorListTool>('monitorListTool');
