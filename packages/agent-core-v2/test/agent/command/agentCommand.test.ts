import { beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { createDecorator, ScopeActivation } from '#/_base/di/instantiation';
import {
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { LifecycleScope } from '#/app/scopes';
import {
  IAgentCommandService,
} from '#/agent/command/agentCommand';
import { AgentCommandService } from '#/agent/command/agentCommandService';
import {
  CommandContribution,
  type CommandRunContext,
} from '#/agent/command/commandContribution';
import { ErrorCodes } from '#/errors';

interface IEcho {
  readonly _serviceBrand: undefined;
  readonly value: string;
}
const IEcho = createDecorator<IEcho>('test-command-echo');

const ICommandProvider = createDecorator<Service>('test-command-provider');

describe('AgentCommandService — CommandContribution fold', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Agent,
      IAgentCommandService,
      AgentCommandService,
      ScopeActivation.OnDemand,
      'command',
    );
  });

  function hostWithProvider(
    contributions: ReadonlyArray<{
      readonly name: string;
      readonly description?: string;
      readonly run: (ctx: CommandRunContext) => void | Promise<void>;
    }>,
  ) {
    class CommandProvider extends Service {
      constructor() {
        super();
        for (const contribution of contributions) {
          this.provide(CommandContribution, contribution);
        }
      }
    }
    const host = createScopedTestHost([stubPair(IEcho, { _serviceBrand: undefined, value: 'echo!' })]);
    const handle = host.app.instantiation.provide(ICommandProvider, new SyncDescriptor(CommandProvider));
    host.app.accessor.get(ICommandProvider);
    const agent = host.child(LifecycleScope.Agent, 'agent-1');
    return { host, agent, handle, commands: agent.accessor.get(IAgentCommandService) };
  }

  it('lists contributed commands with source and runs them with container access', async () => {
    const calls: string[] = [];
    const { host, commands } = hostWithProvider([
      {
        name: 'alpha',
        description: 'the alpha command',
        run: (ctx) => {
          calls.push(`alpha:${ctx.args}`);
        },
      },
      {
        name: 'beta',
        run: (ctx) => {
          calls.push(`beta:${ctx.get(IEcho).value}`);
        },
      },
      {
        name: 'gamma',
        run: async (ctx) => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          calls.push(`gamma:${ctx.args}`);
        },
      },
    ]);

    expect(commands.list().map((command) => command.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(commands.list()[0]).toMatchObject({
      name: 'alpha',
      description: 'the alpha command',
      source: 'CommandProvider',
    });

    await commands.run('alpha', 'x y');
    await commands.run('beta');
    await commands.run('gamma', 'z');
    expect(calls).toEqual(['alpha:x y', 'beta:echo!', 'gamma:z']);
    host.dispose();
  });

  it('shadows an earlier record with a later one of the same name', async () => {
    const calls: string[] = [];
    const { host, commands } = hostWithProvider([
      {
        name: 'dup',
        run: () => {
          calls.push('first');
        },
      },
      {
        name: 'dup',
        run: () => {
          calls.push('second');
        },
      },
    ]);

    expect(commands.list()).toHaveLength(1);
    await commands.run('dup');
    expect(calls).toEqual(['second']);
    host.dispose();
  });

  it('fails unknown commands with a coded REQUEST_INVALID error', async () => {
    const { host, commands } = hostWithProvider([]);
    await expect(commands.run('nope')).rejects.toMatchObject({
      code: ErrorCodes.REQUEST_INVALID,
    });
    host.dispose();
  });

  it('withdraws the commands when the provider unit dies', async () => {
    const { host, handle, commands } = hostWithProvider([
      { name: 'alpha', run: () => {} },
    ]);
    expect(commands.list()).toHaveLength(1);

    handle.dispose();
    await host.app.instantiation.cascade.whenIdle();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(commands.list()).toHaveLength(0);
    host.dispose();
  });
});
