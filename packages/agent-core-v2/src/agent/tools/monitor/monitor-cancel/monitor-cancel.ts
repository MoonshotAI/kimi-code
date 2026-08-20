import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const MonitorCancelInputSchema = z.object({
  monitor_id: z.string().describe('The monitor ID to cancel, as returned by MonitorCreate or MonitorList.'),
});

export type MonitorCancelInput = z.infer<typeof MonitorCancelInputSchema>;

export interface IMonitorCancelTool extends AgentTool<MonitorCancelInput> { readonly _serviceBrand: undefined }
export const IMonitorCancelTool = createDecorator<IMonitorCancelTool>('monitorCancelTool');
