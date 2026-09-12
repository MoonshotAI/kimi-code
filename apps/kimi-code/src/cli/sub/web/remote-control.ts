import chalk from 'chalk';

import { getVersion } from '../../version';
import { darkColors } from '../../../tui/theme/colors';
import { supportsHyperlinks, toTerminalHyperlink } from '../../../utils/terminal-hyperlink';
import type { RemoteControlStatus } from '@moonshot-ai/remote-control';
import { buildOpenableUrl, splitTokenFragment } from './access-urls';

export {
  acquireRemoteControlLock,
  buildRemoteControlUrl,
  filterForwardRequestHeaders,
  formatRemoteControlAlreadyRunning,
  inspectRemoteControlLock,
  parseRawHttpRequest,
  remoteControlLockPath,
  RemoteControlAlreadyRunningError,
  REMOTE_CONTROL_RELAY_ORIGIN,
  REMOTE_CONTROL_RELAY_URL_ENV,
  resolveRemoteControlRelayOrigin,
  rewriteRemoteControlResponse,
  startRemoteControl,
} from '@moonshot-ai/remote-control';
export type {
  ParsedRawHttpRequest,
  RemoteControlHandle,
  RemoteControlLock,
  RemoteControlLockInfo,
  RemoteControlOptions,
  RemoteControlStatus,
} from '@moonshot-ai/remote-control';

export interface RemoteControlOutputOptions {
  readonly url: string;
  readonly localOrigin: string;
  readonly localServerToken: string;
  readonly deviceName: string;
  readonly qrCode: string;
  readonly pngPath: string;
}

export function formatRemoteControlOutput(options: RemoteControlOutputOptions): string {
  const title = (text: string): string => chalk.bold.hex(darkColors.primary)(text);
  const label = (text: string): string => chalk.bold.hex(darkColors.textDim)(text);
  const accent = (text: string): string => chalk.hex(darkColors.accent)(text);
  const dim = (text: string): string => chalk.hex(darkColors.textDim)(text);
  const muted = (text: string): string => chalk.hex(darkColors.textMuted)(text);
  const status = (text: string): string => chalk.hex(darkColors.success)(text);
  const link = (url: string): string =>
    supportsHyperlinks() ? toTerminalHyperlink(accent(url), url) : accent(url);
  const docs = toTerminalHyperlink('docs', 'https://kimi.com/code/docs/remote-control');
  const feedback = toTerminalHyperlink('feedback', 'https://kimi.com/code/feedback');
  const [localBase, localFrag] = splitTokenFragment(
    buildOpenableUrl(options.localOrigin, options.localServerToken),
  );
  return [
    '',
    `  ${title('Kimi Remote Control ready')}  ${muted(getVersion())}`,
    `  ${muted('Use Kimi Code on this machine from your phone or another computer.')}`,
    '',
    `  ${label('1.')} Scan the QR code, or open ${link(options.url)}`,
    `  ${label('2.')} Log in with your Kimi account`,
    `  ${label('3.')} Start chatting — sessions run on this machine`,
    '',
    `  ${status('✓')} ${muted(`Connected to ${new URL(options.url).host}, waiting for remote devices…`)}`,
    `  ${label('This device: ')}${muted(options.deviceName)}`,
    `  ${status('⚠')} ${muted('This link grants control of this machine. Do not share it.')}`,
    '',
    options.qrCode.trimEnd().replaceAll(/^/gm, '    '),
    `  ${label('QR code PNG: ')}${options.pngPath} ${muted('(open this if the QR above does not scan)')}`,
    `  ${label('Local UI: ')}${accent(localBase)}${dim(localFrag)} ${muted('(LAN: --host)')}`,
    '',
    `  ${docs} ${muted('·')} ${feedback}`,
    `  ${label('Logs: ')}${muted('off (--log-level info)')} ${muted('·')} ${label('Stop: ')}${muted('Ctrl+C')}`,
    '',
  ].join('\n');
}

export function formatRemoteControlStatus(status: RemoteControlStatus): string {
  const label = (text: string): string => chalk.bold.hex(darkColors.textDim)(text);
  const value = (text: string): string => chalk.hex(darkColors.success)(text);
  switch (status) {
    case 'relay_connected':
      return `  ${value('✓')} ${label('Connected to relay, waiting for remote devices…')}\n`;
    case 'relay_disconnected':
      return `  ${value('!')} ${label('Relay disconnected; reconnecting…')}\n`;
    case 'device_connected':
      return `  ${value('✓')} ${label('Remote device connected (1 active session)')}\n`;
    case 'device_disconnected':
      return `  ${value('→')} ${label('Remote device disconnected')}\n`;
  }
}
