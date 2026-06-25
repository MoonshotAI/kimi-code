import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IOAuthService } from '#/auth/auth';
import { IMcpService } from '#/mcp/mcp';

import { McpService } from '#/mcp/mcpService';
import { registerConfigServices } from '../config/stubs';
import { registerLogServices } from '../log/stubs';
import { registerTelemetryServices } from '../telemetry/stubs';

describe('McpService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [
        registerConfigServices,
        registerLogServices,
        registerTelemetryServices,
      ],
      additionalServices: (reg) => {
        reg.definePartialInstance(IOAuthService, {});
        reg.define(IMcpService, McpService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('connect / disconnect / list + status events', async () => {
    const svc = ix.get(IMcpService);
    const statuses: string[] = [];
    svc.onDidChangeServerStatus((e) => statuses.push(`${e.serverId}:${e.status}`));
    await svc.connect('s1');
    await svc.connect('s2');
    expect([...svc.list()].sort()).toEqual(['s1', 's2']);
    await svc.disconnect('s1');
    expect(svc.list()).toEqual(['s2']);
    expect(statuses).toEqual(['s1:connected', 's2:connected', 's1:disconnected']);
  });
});
