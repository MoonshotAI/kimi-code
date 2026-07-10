import type { InjectionKey } from 'vue';
import type { KimiWebClientCore } from './createKimiWebClientCore';

/** Provide/inject key for the per-app session state-machine core. The consumer
 *  (web or desktop shell) creates one core via `createKimiWebClientCore(...)` and
 *  `app.provide(KimiWebClientCoreKey, core)`; the shell composable injects it. */
export const KimiWebClientCoreKey: InjectionKey<KimiWebClientCore> = Symbol('KimiWebClientCore');
