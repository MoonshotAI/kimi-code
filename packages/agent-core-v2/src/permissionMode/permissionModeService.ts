import type { PermissionMode } from '#/permissionPolicy';
import {
  Disposable,
} from "#/_base/di";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { IDynamicInjector } from '#/dynamicInjector';
import { IEventBus } from '#/eventBus';
import { OrderedHookSlot } from '../hooks';
import { IReplayBuilderService } from '#/replayBuilder';
import type { WireRecord } from '#/wireRecord';
import { IWireRecord } from '#/wireRecord';
import { registerPermissionModeInjection } from './injection/permissionModeInjection';
import { IPermissionModeService } from './permissionMode';

declare module '#/wireRecord' {
  interface WireRecordMap {
    'permission.set_mode': {
      mode: PermissionMode;
    };
  }
}

export class PermissionModeService extends Disposable implements IPermissionModeService {
  declare readonly _serviceBrand: undefined;

  private currentMode: PermissionMode = 'manual';

  readonly hooks = {
    onChanged: new OrderedHookSlot<{
      mode: PermissionMode;
      previousMode: PermissionMode;
    }>(),
  };

  constructor(
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IEventBus private readonly events: IEventBus,
    @IReplayBuilderService private readonly replayBuilder: IReplayBuilderService,
    @IDynamicInjector dynamicInjector: IDynamicInjector,
  ) {
    super();
    this._register(
      wireRecord.register('permission.set_mode', (record) => {
        this.applyMode(record);
      }),
    );
    this._register(
      registerPermissionModeInjection(dynamicInjector, this),
    );
  }

  get mode(): PermissionMode {
    return this.currentMode;
  }

  setMode(mode: PermissionMode): void {
    this.wireRecord.append({ type: 'permission.set_mode', mode });
    this.applyMode({ type: 'permission.set_mode', mode });
  }

  private applyMode(record: WireRecord<'permission.set_mode'>): void {
    this.replayBuilder.push({ type: 'permission_updated', mode: record.mode });
    const previousMode = this.currentMode;
    this.currentMode = record.mode;
    this.events.emit({
      type: 'agent.status.updated',
      permission: this.currentMode,
    });
    void this.hooks.onChanged.run({ mode: this.currentMode, previousMode });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IPermissionModeService,
  PermissionModeService,
  InstantiationType.Delayed,
  'permissionMode',
);
