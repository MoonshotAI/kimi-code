import { Disposable } from '#/_base/di/lifecycle';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { ArtexFindingNode } from '#/features/artex/protocol/index';
import {
  ArtexNotificationDispatcher,
  type ArtexNotificationDispatcherOptions,
} from '#/features/artex/notify/dispatcher';
import {
  EVENT_FINDING_CREATED,
  EVENT_FINDING_STATUS_CHANGED,
  type NotifySnapshot,
} from '#/features/artex/notify/types';

export interface IArtexNotificationHub {
  readonly _serviceBrand: undefined;
  readonly dispatcher: ArtexNotificationDispatcher;
  onFindingCreated(explorationId: number, finding: ArtexFindingNode): void;
  onFindingStatusChanged(
    explorationId: number,
    finding: ArtexFindingNode,
    fromStatus: string,
    toStatus: string,
  ): void;
}

export const IArtexNotificationHub: ServiceIdentifier<IArtexNotificationHub> =
  createDecorator<IArtexNotificationHub>('artexNotificationHub');

function payloadString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value.trim() : '';
}

function payloadAssetIds(payload: Record<string, unknown>): readonly number[] {
  const raw = payload['asset_ids'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is number => typeof item === 'number' && Number.isInteger(item));
}

function snapshotFromFinding(
  kind: NotifySnapshot['kind'],
  explorationId: number,
  finding: ArtexFindingNode,
  extra?: Pick<NotifySnapshot, 'fromStatus' | 'toStatus'>,
): NotifySnapshot {
  const payload = finding.payload as Record<string, unknown>;
  const payloadFindingId = payload['finding_id'];
  const findingId = typeof payloadFindingId === 'number' ? payloadFindingId : finding.id;
  return {
    kind,
    findingId,
    taskId: explorationId,
    vulnclass: payloadString(payload, 'vulnclass'),
    name: payloadString(payload, 'name'),
    severity: payloadString(payload, 'severity'),
    summary: payloadString(payload, 'summary'),
    assetIds: payloadAssetIds(payload),
    fromStatus: extra?.fromStatus,
    toStatus: extra?.toStatus,
  };
}

export class ArtexNotificationHub extends Disposable implements IArtexNotificationHub {
  declare readonly _serviceBrand: undefined;

  readonly dispatcher: ArtexNotificationDispatcher;

  constructor(options: ArtexNotificationDispatcherOptions = {}) {
    super();
    this.dispatcher = new ArtexNotificationDispatcher(options);
    this.dispatcher.start();
    this._register({
      dispose: () => {
        this.dispatcher.dispose();
      },
    });
  }

  onFindingCreated(explorationId: number, finding: ArtexFindingNode): void {
    this.dispatcher.enqueue(
      snapshotFromFinding(EVENT_FINDING_CREATED, explorationId, finding),
    );
  }

  onFindingStatusChanged(
    explorationId: number,
    finding: ArtexFindingNode,
    fromStatus: string,
    toStatus: string,
  ): void {
    if (fromStatus === toStatus) return;
    this.dispatcher.enqueue(
      snapshotFromFinding(EVENT_FINDING_STATUS_CHANGED, explorationId, finding, {
        fromStatus,
        toStatus,
      }),
    );
  }
}