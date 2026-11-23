import { watchEffect } from 'vue';
import { BROWSER_CONTROL_ACTIVITIES, type BrowserControlConfig, type BrowserControlDialogLabels, type BrowserControlOwnership, type BrowserControlPresentation } from '../../shared/browser-control';
import { BROWSER_DIALOG_RECORD_ANSWERERS, BROWSER_DIALOG_RECORD_KINDS, BROWSER_DIALOG_RECORD_OUTCOMES } from '../../shared/browser-dialogs';

type Translate = (key: string, named?: Record<string, string>) => string;

function labelMap<T extends string>(names: readonly T[], t: Translate, prefix: string): Record<T, string> {
  return Object.fromEntries(names.map(name => [name, t(`${prefix}.${name}`)])) as Record<T, string>;
}

export function browserControlDialogLabels(t: Translate): BrowserControlDialogLabels {
  return {
    button: t('browser.dialogRecords.button'), title: t('browser.dialogRecords.title'),
    answeredBy: t('browser.dialogRecords.answeredBy', { outcome: '{outcome}', answerer: '{answerer}' }),
    showInFolder: t('browser.dialogRecords.showInFolder'), move: t('browser.dialogRecords.move'),
    kinds: labelMap(BROWSER_DIALOG_RECORD_KINDS, t, 'browser.dialogRecords.kinds'),
    outcomes: labelMap(BROWSER_DIALOG_RECORD_OUTCOMES, t, 'browser.dialogRecords.outcomes'),
    answerers: labelMap(BROWSER_DIALOG_RECORD_ANSWERERS, t, 'browser.dialogRecords.answerers'),
  };
}

export function watchBrowserControlPresentation(
  controls: () => BrowserControlPresentation[],
  t: (key: string, named?: Record<string, string>) => string,
  onOwnership: (state: BrowserControlOwnership) => void,
): () => void {
  const bridge = (window as { kimiDesktop?: {
    browserSetControls?: (config: BrowserControlConfig) => void;
    onBrowserControlOwnership?: (cb: (state: BrowserControlOwnership) => void) => () => void;
  } }).kimiDesktop;
  if (!bridge?.browserSetControls) return () => {};
  const offOwnership = bridge.onBrowserControlOwnership?.(onOwnership);
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const color = window.matchMedia('(prefers-color-scheme: dark)');
  const update = (): void => {
    const scheme = document.documentElement.dataset.colorScheme;
    bridge.browserSetControls?.({
      controls: controls(),
      labels: {
        running: t('browser.controlOverlayRunning'), elapsed: t('browser.controlElapsed', { time: '{time}' }),
        takeover: t('browser.controlTakeover'), takeoverHint: t('browser.controlTakeoverHint'),
        pointer: t('browser.controlPointer'), typing: t('browser.controlTyping'),
        key: t('browser.controlKey'), scrolling: t('browser.controlScroll'),
        activityTarget: t('browser.controlActivityTarget', { activity: '{activity}', target: '{target}' }),
        activities: Object.fromEntries(BROWSER_CONTROL_ACTIVITIES.map(name => [name, t(`browser.controlActivities.${name}`)])) as BrowserControlConfig['labels']['activities'],
        dialogs: browserControlDialogLabels(t),
      },
      colorScheme: scheme === 'dark' || (scheme !== 'light' && color.matches) ? 'dark' : 'light',
      reducedMotion: motion.matches,
    });
  };
  const stop = watchEffect(update, { flush: 'post' });
  const observer = new MutationObserver(update);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-color-scheme', 'style', 'class'] });
  motion.addEventListener('change', update);
  color.addEventListener('change', update);
  return () => { stop(); offOwnership?.(); observer.disconnect(); motion.removeEventListener('change', update); color.removeEventListener('change', update); };
}
