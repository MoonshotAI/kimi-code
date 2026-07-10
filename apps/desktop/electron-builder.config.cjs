'use strict';

// electron-builder configuration.
//
// Signing / notarization are environment-driven so the same config produces
// either an unsigned local build or a fully signed + notarized distributable:
//
//   unsigned (default / local):
//     CSC_IDENTITY_AUTO_DISCOVERY=false  -> no signing, no notarization
//
//   signed + notarized (CI, with a Developer ID cert in the keychain):
//     KIMI_DESKTOP_NOTARIZE=true
//     APPLE_API_KEY=<path to .p8>  APPLE_API_KEY_ID=<id>  APPLE_API_ISSUER=<id>
//
// The entitlements (hardened runtime) are applied to the app AND every nested
// Mach-O — including the bundled Kimi SEA backend — via entitlementsInherit, so
// the whole bundle passes notarization. Mirrors the TUI's native entitlements.

const notarize = process.env.KIMI_DESKTOP_NOTARIZE === 'true';

// Internal-testing artifact name:
//   KCD-beta-alpha-crazy-internal-v50-<arch>-<MMDD>.<ext>
// The date is MMDD in UTC+8, computed at build time. `v50` is a fixed label
// (not a version number) — edit it here to bump the internal build label.
function mmddUTC8() {
  const utc8 = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const mm = String(utc8.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc8.getUTCDate()).padStart(2, '0');
  return mm + dd;
}
const artifactName = 'KCD-beta-alpha-crazy-internal-v50-${arch}-' + mmddUTC8() + '.${ext}';

module.exports = {
  appId: 'ai.moonshot.kimi.desktop',
  productName: 'Kimi Code Desktop',
  copyright: 'Copyright © Moonshot AI',

  directories: {
    output: 'dist-app',
  },

  // No native node modules in the Electron app itself; the backend is the
  // prebuilt SEA staged by before-pack.cjs.
  npmRebuild: false,
  asar: true,

  files: ['out/**', 'package.json'],

  beforePack: './scripts/before-pack.cjs',
  extraResources: [{ from: 'resources-stage/bin', to: 'bin' }],

  mac: {
    category: 'public.app-category.developer-tools',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    target: ['dmg', 'zip'],
    artifactName,
    notarize,
  },

  win: {
    target: ['nsis'],
    artifactName,
  },

  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },

  linux: {
    category: 'Development',
    target: ['AppImage', 'deb'],
    artifactName,
    maintainer: 'Moonshot AI',
  },
};
