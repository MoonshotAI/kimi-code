import { dingTalkChannel } from './channels/dingtalk';
import { emailChannel } from './channels/email';
import { feishuChannel } from './channels/feishu';
import { telegramChannel } from './channels/telegram';
import { webhookChannel } from './channels/webhook';
import { weComChannel } from './channels/wecom';
import type { NotifyChannel, NotifyChannelKind } from './types';

export const NOTIFY_CHANNELS: Readonly<Record<NotifyChannelKind, NotifyChannel>> = {
  dingtalk: dingTalkChannel,
  feishu: feishuChannel,
  wecom: weComChannel,
  webhook: webhookChannel,
  telegram: telegramChannel,
  email: emailChannel,
};

export function getNotifyChannel(kind: string): NotifyChannel | undefined {
  if (!isValidNotifyKind(kind)) return undefined;
  return NOTIFY_CHANNELS[kind];
}

export function isValidNotifyKind(kind: string): kind is NotifyChannelKind {
  return Object.prototype.hasOwnProperty.call(NOTIFY_CHANNELS, kind);
}

export function listNotifyKinds(): NotifyChannelKind[] {
  return (Object.keys(NOTIFY_CHANNELS) as NotifyChannelKind[]).toSorted((a, b) =>
    a.localeCompare(b),
  );
}
