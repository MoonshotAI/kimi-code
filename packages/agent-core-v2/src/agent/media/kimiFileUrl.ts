/**
 * `media` domain — the `kimi-file://` internal media reference.
 *
 * Aliases of the contract-layer daemon file reference (`kosong/contract/
 * mediaRef`), kept under the historical names so existing call sites read
 * unchanged. New code should prefer the canonical `*DaemonFile*` names.
 * Pure helpers; no scoped service.
 */

export {
  buildDaemonFileUrl as buildKimiFileUrl,
  isDaemonFileUrl as isKimiFileUrl,
  parseDaemonFileUrl as parseKimiFileUrl,
  type DaemonFileRef as KimiFileRef,
} from '#/kosong/contract/mediaRef';
