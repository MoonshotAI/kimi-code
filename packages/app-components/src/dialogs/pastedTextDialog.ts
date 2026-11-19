import { shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';

export interface PastedTextDialogState {
  text: string;
  save?: (text: string) => void;
}

export const pastedTextDialogState = shallowRef<PastedTextDialogState | null>(null);

export function openPastedTextDialog(text: string, save?: (text: string) => void): void {
  pastedTextDialogState.value = save === undefined ? { text } : { text, save };
}

export function closePastedTextDialog(): void {
  pastedTextDialogState.value = null;
}

export function usePastedTextStats(): (lineCount: number, charCount: number) => string {
  const { t, locale } = useI18n();
  return (lineCount, charCount) => [
    t('composer.pastedTextLines', { n: lineCount.toLocaleString(locale.value) }, lineCount),
    t('composer.pastedTextChars', { n: charCount.toLocaleString(locale.value) }, charCount),
  ].join(' · ');
}
