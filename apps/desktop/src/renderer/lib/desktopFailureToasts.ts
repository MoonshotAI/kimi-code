import type { AppNotice } from '@moonshot-ai/app-core/api';
import type { DesktopFailureKind } from '../../shared/failure-feedback';

interface DesktopFailureBridge {
  onFailureToast?: (cb: (kind: DesktopFailureKind, url?: string) => void) => () => void;
}

export function desktopFailureNotice(kind: DesktopFailureKind, t: (key: string) => string, url?: string): AppNotice {
  const prefix = kind === 'external-link' ? 'externalLinkOpenFailed' : 'screenshotSaveFailed';
  return {
    severity: 'warning',
    title: t(`app.${prefix}Title`),
    message: t(`app.${prefix}Message`),
    ...(kind === 'external-link' && url !== undefined ? {
      copyLink: {
        label: t('app.externalLinkOpenFailedCopy'),
        copiedLabel: t('app.externalLinkOpenFailedCopied'),
        url,
      },
    } : {}),
  };
}

export function observeDesktopFailureToasts(
  notify: (notice: AppNotice) => void,
  t: (key: string) => string,
): () => void {
  const off = (window as { kimiDesktop?: DesktopFailureBridge }).kimiDesktop?.onFailureToast?.((kind, url) => {
    notify(desktopFailureNotice(kind, t, url));
  });
  return () => off?.();
}
