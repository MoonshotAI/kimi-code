'use strict';

// electron-builder configuration.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
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

// Release artifact name:
//   KimiCode-<version>-<os>-<arch>.<ext>
// The version number must be in the file name: electron-updater resolves the
// download URL from the file names recorded in latest*.yml, and the CDN keeps
// every version's artifacts side by side under desktop/<version>/.
const artifactName = 'KimiCode-${version}-${os}-${arch}.${ext}';

// macOS 26 Tahoe Liquid Glass icon (dark/tinted/clear appearances), embedded
// only when the design artifact exists: `build/AppIcon.icon`, authored ONCE in
// Icon Composer (Xcode 26) — the layered format and its glass/appearance
// treatments are visual-tuning work, not generatable from the flat kit PNGs
// (see scripts/build-brand-icons.mjs). When the file is absent this hook is a
// no-op and the app keeps the static .icns on every macOS version.
//
// When present, actool (Xcode 26, macOS 26 SDK — on the macos-* CI runners)
// compiles it to Assets.car and CFBundleIconName points at it; the existing
// CFBundleIconFile (icon.icns) stays as the pre-Tahoe fallback. Runs in
// afterPack, i.e. before signing/notarization, so the bundle is sealed with
// the catalog inside. NOTE: the .icon package must be named AppIcon.icon —
// CFBundleIconName below and --app-icon both reference that stem.
async function embedTahoeIconCatalog(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const iconPkg = path.join(__dirname, 'build', 'AppIcon.icon');
  if (!fs.existsSync(iconPkg)) return;

  // Artifact present but no toolchain: fail loudly, never silently ship a
  // build that ignores the intended icon.
  const actool = execFileSync('xcrun', ['-f', 'actool'], { encoding: 'utf8' }).trim();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-car-'));
  execFileSync(
    actool,
    [
      iconPkg,
      '--compile', tmp,
      '--output-format', 'human-readable-text',
      '--notices', '--warnings', '--errors',
      '--output-partial-info-plist', path.join(tmp, 'partial.plist'),
      '--app-icon', 'AppIcon',
      '--include-all-app-icons',
      '--enable-on-demand-resources', 'NO',
      '--development-region', 'en',
      '--target-device', 'mac',
      '--minimum-deployment-target', '26.0',
      '--platform', 'macosx',
    ],
    { stdio: 'inherit' },
  );

  const appDir = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  fs.copyFileSync(path.join(tmp, 'Assets.car'), path.join(appDir, 'Contents', 'Resources', 'Assets.car'));
  const plist = path.join(appDir, 'Contents', 'Info.plist');
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :CFBundleIconName string AppIcon', plist]);
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIconName AppIcon', plist]);
  }
  console.log('[afterPack] embedded Assets.car (CFBundleIconName=AppIcon; .icns kept as pre-Tahoe fallback)');
}

module.exports = {
  appId: 'com.kimi.code.desktop',
  productName: 'Kimi Code',
  copyright: 'Copyright © Moonshot AI',

  afterPack: embedTahoeIconCatalog,

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

  // electron-updater feed: the desktop clients poll latest*.yml at this URL
  // (the CDN root for desktop artifacts; installers live under <version>/
  // subdirs — see kimi-cli-cdn-sync/publish-desktop.sh). Setting `publish`
  // also makes electron-builder emit latest-mac.yml / latest.yml /
  // latest-linux.yml + *.blockmap into dist-app on every build.
  publish: [{ provider: 'generic', url: 'https://code.kimi.com/kimi-code/desktop/' }],

  // The desktop renderer is built independently via `vite.renderer.config.ts`
  // into `desktop-dist` (decoupled from the CLI/SEA `web-dist`). Ship it as an
  // extra resource so the `app://renderer` protocol and the server's static
  // fallback both read from `<resourcesPath>/desktop-dist`.
  // `build/lproj` carries localized InfoPlist.strings (TCC prompt copy — see
  // mac.extendInfo); lproj dirs must sit directly under Contents/Resources.
  // `build/tray*` are the system-tray icons (see src/main/tray.ts).
  // NOTE: extraResources does NOT expand globs in `from` (a pattern is treated
  // as a literal path and silently skipped) — use directory form + `filter`.
  extraResources: [
    { from: 'desktop-dist', to: 'desktop-dist' },
    { from: 'build/lproj/', to: '.' },
    { from: 'build/', to: 'build/', filter: ['tray*'] },
  ],

  mac: {
    category: 'public.app-category.developer-tools',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // `build/icon*.png` are the theme-following Dock icons (src/main/dock-icon.ts)
    // — macOS-only feature, shipped only in mac packages (merged with the
    // top-level extraResources).
    extraResources: [
      { from: 'build/', to: 'build/', filter: ['icon*.png'] },
    ],
    // dmg for first-install distribution, zip for electron-updater (macOS
    // auto-update only works from the zip archive).
    target: ['dmg', 'zip'],
    artifactName,
    notarize,
    // TCC usage descriptions (English baseline): shown in the macOS permission
    // prompt the first time the app touches files under ~/Desktop, ~/Documents
    // or ~/Downloads (e.g. a workspace opened there). Simplified-Chinese
    // overrides ship in build/lproj/zh_CN.lproj/InfoPlist.strings and take
    // precedence for zh_CN users.
    extendInfo: {
      NSDesktopFolderUsageDescription:
        'Kimi Code only accesses files in your Desktop folder when you open a project located there.',
      NSDocumentsFolderUsageDescription:
        'Kimi Code only accesses files in your Documents folder when you open a project located there.',
      NSDownloadsFolderUsageDescription:
        'Kimi Code only accesses files in your Downloads folder when you open a project located there.',
    },
  },

  win: {
    target: ['nsis'],
    artifactName,
    extraResources: [{ from: 'build/icon.ico', to: 'build/icon.ico' }],
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
    // electron-builder 26 校验 executableName 的文件路径合法性；不显式设置时会
    // 从 package.json 的 name 派生（老包名带 @moonshot-ai/ 前缀，派生值含 @ 非法）。
    executableName: 'kimi-code',
  },
};
