import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IOAuthService } from '#/auth/auth';
import { IConfigService } from '#/config/config';
import { ILogService } from '#/log/log';
import { ITelemetryService } from '#/telemetry/telemetry';

import { McpService } from '#/mcp/mcpService';

describe('McpService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IConfigService, {});
    ix.stub(ILogService, {});
    ix.stub(ITelemetryService, {});
    ix.stub(IOAuthService, {});
  });
  afterEach(() => disposables.dispose());

  it('connect / disconnect / list + status events', async () => {
    const svc = disposables.add(ix.createInstance(McpService));
    const statuses: string[] = [];
    svc.onDidChangeServerStatus((e) => statuses.push(`${e.serverId}:${e.status}`));
    await svc.connect('s1');
    await svc.connect('s2');
    expect([...svc.list()].sort()).toEqual(['s1', 's2']);
    await svc.disconnect('s1');
    expect(svc.list()).toEqual(['s2']);
    expect(statuses).toEqual(['s1:connected', 's2:connected', 's1:disconnected']);
    svc.dispose();
  });
});
