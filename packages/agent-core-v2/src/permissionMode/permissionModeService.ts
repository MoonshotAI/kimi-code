import type { PermissionMode } from '../../../agent/permission';
import { Disposable, registerSingleton, SyncDescriptor } from "#/_base/di";

import { IDynamicInjector } from '../dynamicInjector/dynamicInjector';
import { IEventBus } from '../eventBus/eventBus';
import { OrderedHookSlot } from '../hooks';
import { IReplayBuilderService } from '../replayBuilder/replayBuilder';
import type { WireRecord } from '../types';
import { IWireRecord } from '../wireRecord/wireRecord';
import { registerPermissionModeInjection } from './injection/permissionModeInjection';
import { IPermissionModeService } from './permissionMode';

declare module '../types' {
  interface WireRecordMap {
    'permission.set_mode': {
      mode: PermissionMode;
    };
  }
}

export class PermissionModeService extends Disposable implements IPermissionModeService {
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

registerSingleton(
  IPermissionModeService,
  new SyncDescriptor(PermissionModeService, [], true),
);
