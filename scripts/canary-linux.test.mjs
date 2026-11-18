import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const desktopRequire = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const builderRequire = createRequire(desktopRequire.resolve('electron-builder'));
const { getAppUpdatePublishConfiguration } = builderRequire('app-builder-lib/out/publish/PublishManager');
const { AppInfo } = builderRequire('app-builder-lib/out/appInfo');
const { LinuxTargetHelper } = builderRequire('app-builder-lib/out/targets/LinuxTargetHelper');
const configPath = require.resolve('../apps/desktop/electron-builder.config.cjs');

for (const canary of [false, true]) {
  test(`Linux ${canary ? 'Canary' : 'stable'} packaging emits isolated application metadata`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'linux-package-'));
    const previous = process.env.KIMI_DESKTOP_CANARY;
    try {
      process.env.KIMI_DESKTOP_CANARY = String(canary);
      delete require.cache[configPath];
      const config = require(configPath);
      const executable = canary ? 'kimi-code-canary' : 'kimi-code';
      const appId = canary ? 'com.kimi.code.desktop.canary' : 'com.kimi.code.desktop';
      assert.equal(config.linux.executableName, executable);
      assert.deepEqual(config.linux.target, ['AppImage', 'deb', 'rpm']);
      if (canary) {
        assert.equal(config.deb.packageName, executable);
        assert.equal(config.rpm.packageName, executable);
        assert.equal(config.linux.icon, 'build/icon-canary.png');
        assert.deepEqual(config.protocols, []);
        assert.equal(config.publish[0].channel, 'canary');
      } else {
        assert.equal(config.deb.packageName, undefined);
        assert.equal(config.rpm.packageName, undefined);
        assert.equal(config.publish[0].channel, 'latest');
      }
      mkdirSync(join(directory, 'resources'));
      writeFileSync(join(directory, 'resources/app-update.yml'), 'updaterCacheDirName: kimi-code-app-updater\n');
      const appInfo = Object.create(AppInfo.prototype);
      Object.defineProperties(appInfo, {
        name: { value: 'kimi-code-app' },
        version: { value: '1.1.0-canary.120' },
        productName: { value: config.productName },
        productFilename: { value: config.productName },
        sanitizedProductName: { value: config.productName },
        description: { value: config.linux.description },
      });
      const packager = {
        appInfo, config, platformSpecificBuildOptions: config.linux, expandMacro: (value) => value,
        executableName: executable, fileAssociations: [], info: { config, appInfo, metadata: config.extraMetadata },
      };
      await config.afterPack({
        electronPlatformName: 'linux', appOutDir: directory, outDir: directory,
        packager,
      });
      const xml = readFileSync(join(directory, 'usr/share/metainfo', `${appId}.metainfo.xml`), 'utf8');
      assert.match(xml, new RegExp(`<id>${appId}</id>`));
      assert.ok(xml.includes(`<launchable type="desktop-id">${executable}.desktop</launchable>`));
      assert.ok(xml.includes(`<icon type="stock">${executable}</icon>`));
      assert.ok(xml.includes(`<name>${config.productName}</name>`));
      assert.equal(xml, readFileSync(join(directory, 'linux-metainfo', `${appId}.metainfo.xml`), 'utf8'));
      for (const target of [config.deb, config.rpm]) {
        assert.ok(target.fpm[0].endsWith(`=/usr/share/metainfo/${appId}.metainfo.xml`));
      }
      const rebuilt = await getAppUpdatePublishConfiguration(packager, null, 1, false);
      assert.equal(rebuilt.updaterCacheDirName, `${canary ? 'kimi-code-canary' : 'kimi-code-app'}-updater`);
      assert.equal(config.extraMetadata.desktopName, `${executable}.desktop`);
      assert.equal(config.linux.syncDesktopName, true);
      const targetHelper = new LinuxTargetHelper(packager);
      assert.equal(targetHelper.getDesktopFileName(), executable);
      const desktopEntry = await targetHelper.computeDesktopEntry(config.linux);
      assert.match(desktopEntry, new RegExp(`^Name=${config.productName}$`, 'm'));
      assert.match(desktopEntry, new RegExp(`^StartupWMClass=${executable}$`, 'm'));
      const updater = readFileSync(join(directory, 'resources/app-update.yml'), 'utf8');
      assert.equal(updater, `updaterCacheDirName: ${canary ? 'kimi-code-canary' : 'kimi-code-app'}-updater\n`);
    } finally {
      if (previous === undefined) delete process.env.KIMI_DESKTOP_CANARY;
      else process.env.KIMI_DESKTOP_CANARY = previous;
      delete require.cache[configPath];
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
