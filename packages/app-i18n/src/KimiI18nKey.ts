import { inject, type InjectionKey } from 'vue';
import { useI18n } from 'vue-i18n';

export interface KimiI18nApi {
  readonly t: (key: string, params?: Record<string, unknown>) => string;
  readonly locale?: string;
}

export const KimiI18nKey: InjectionKey<KimiI18nApi> = Symbol('KimiI18n');

const identity: KimiI18nApi = { t: (key) => key };

export function useKimiI18n(): KimiI18nApi {
  const provided = inject(KimiI18nKey, null);
  if (provided) return provided;
  try {
    const composer = useI18n();
    return {
      t: (key, params) => composer.t(key, params as never),
      locale: composer.locale.value,
    };
  } catch {
    return identity;
  }
}
