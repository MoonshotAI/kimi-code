import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { cronAgentRuntimeProvider } from '#/features/cron/cronAgentRuntime';
import { ICronCreateTool } from '#/features/cron/tools/cron-create/cron-create';
import { CronCreateTool } from '#/features/cron/tools/cron-create/cronCreateTool';
import { ICronDeleteTool } from '#/features/cron/tools/cron-delete/cron-delete';
import { CronDeleteTool } from '#/features/cron/tools/cron-delete/cronDeleteTool';
import { ICronListTool } from '#/features/cron/tools/cron-list/cron-list';
import { CronListTool } from '#/features/cron/tools/cron-list/cronListTool';

export class CronFeature extends Feature {
  static override readonly name = 'cron';

  constructor() {
    super();
    this.contributeAgentRuntime(cronAgentRuntimeProvider);
    this.contributeTool(ICronCreateTool, CronCreateTool, { name: 'CronCreate', domain: 'cron' });
    this.contributeTool(ICronListTool, CronListTool, { name: 'CronList', domain: 'cron' });
    this.contributeTool(ICronDeleteTool, CronDeleteTool, { name: 'CronDelete', domain: 'cron' });
  }
}

registerFeature(CronFeature);
