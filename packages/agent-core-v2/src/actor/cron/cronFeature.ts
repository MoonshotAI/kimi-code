import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { cronAgentRuntimeProvider } from '#/actor/cron/cronAgentRuntime';
import { CronCreateTool } from '#/actor/cron/tools/cron-create/cronCreateTool';
import { CronDeleteTool } from '#/actor/cron/tools/cron-delete/cronDeleteTool';
import { CronListTool } from '#/actor/cron/tools/cron-list/cronListTool';

export class CronFeature extends Feature {
  static override readonly name = 'cron';

  constructor() {
    super();
    this.contributeAgentRuntime(cronAgentRuntimeProvider);
    this.contributeTool({
      name: 'CronCreate',
      domain: 'cron',
      create: (ctx) => new CronCreateTool(ctx.get(IAgentLifecycleService), ctx.host.scopeContext),
    });
    this.contributeTool({
      name: 'CronList',
      domain: 'cron',
      create: (ctx) => new CronListTool(ctx.get(IAgentLifecycleService), ctx.host.scopeContext),
    });
    this.contributeTool({
      name: 'CronDelete',
      domain: 'cron',
      create: (ctx) => new CronDeleteTool(ctx.get(IAgentLifecycleService), ctx.host.scopeContext),
    });
  }
}

registerFeature(CronFeature);
