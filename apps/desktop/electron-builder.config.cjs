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
// Mach-O — including native `.node` modules loaded by the in-process server —
// via entitlementsInherit, so the whole bundle passes notarization.

const notarize = process.env.KIMI_DESKTOP_NOTARIZE === 'true';

// Internal-testing artifact name:
//   KimiCode-<arch>-<MMDD>.<ext>
// The date is MMDD in UTC+8, computed at build time; it is the only
// build discriminator in the file name (no version number).
function mmddUTC8() {
  const utc8 = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const mm = String(utc8.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc8.getUTCDate()).padStart(2, '0');
  return mm + dd;
}
const artifactName = 'KimiCode-${arch}-' + mmddUTC8() + '.${ext}';

module.exports = {
  appId: 'com.kimi.code.desktop',
  productName: 'Kimi Code',
  copyright: 'Copyright © Moonshot AI',

  directories: {
    output: 'dist-app',
  },

  // `node-pty` is the only native `.node` module in the desktop closure
  // (agent-core's terminal service). It is rebuilt for the Electron ABI by
  // `@electron/rebuild` (postinstall) and unpacked from the asar via
  // `asarUnpack` so the in-process server can `dlopen` it at runtime.
  // (`@mariozechner/clipboard` and `koffi` are CLI / pi-tui only and not present
  // in the desktop closure.)
  npmRebuild: false,
  asar: true,
  asarUnpack: [
    'node_modules/node-pty/**',
  ],

  files: ['out/**', 'package.json'],

  // The desktop renderer is built independently via `vite.renderer.config.ts`
  // into `desktop-dist` (decoupled from the CLI/SEA `web-dist`). Ship it as an
  // extra resource so the `app://renderer` protocol and the server's static
  // fallback both read from `<resourcesPath>/desktop-dist`.
  extraResources: [{ from: 'desktop-dist', to: 'desktop-dist' }],

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
