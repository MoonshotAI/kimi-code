import type { BrowserDialogRecordKind } from '../../shared/browser-dialogs';

const ICONS: Record<BrowserDialogRecordKind, string> = {
  alert: 'info',
  confirm: 'help-circle',
  prompt: 'keyboard',
  beforeunload: 'log-out',
  file: 'file',
  upload: 'attachment',
  download: 'download',
  'external-app': 'external-link',
  print: 'printer',
  'screen-capture': 'device-desktop',
  bluetooth: 'bolt',
  'file-picker': 'folder',
};

export function browserDialogRecordIcon(kind: BrowserDialogRecordKind): string {
  return ICONS[kind];
}
