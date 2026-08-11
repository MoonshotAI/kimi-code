import { inject, type InjectionKey } from 'vue';
import { useI18n } from 'vue-i18n';

export interface KimiI18nApi {
  readonly t: (key: string, params?: Record<string, unknown>) => string;
  readonly locale?: string;
}

export const KimiI18nKey: InjectionKey<KimiI18nApi> = Symbol('KimiI18n');

const identity: KimiI18nApi = { t: (key) => key };

/**
 * Resolve a translator without hard-coupling a consumer to the global vue-i18n.
 * Resolution order: app-provided `KimiI18nKey` (inject) → the installed global
 * vue-i18n composer (`useI18n().global`) → an identity translator `t = (k) => k`
 * that never throws, so a package renders usable keys even with no i18n present.
 */
export function useKimiI18n(): KimiI18nApi {
  const provided = inject(KimiI18nKey, null);
  if (provided) return provided;
  try {
    // `useI18n()` returns the composition Composer directly (it has no `.global`);
    // the Composer itself carries `t` and a settable `locale` ref.
    const composer = useI18n();
    return {
      t: (key, params) => composer.t(key, params as never),
      locale: composer.locale.value,
    };
  } catch {
    return identity;
  }
}
