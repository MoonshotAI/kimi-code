import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(resolve('apps/desktop/package.json'));
const { GenericProvider } = require('electron-updater/out/providers/GenericProvider');
const { findFile } = require('electron-updater/out/providers/Provider');

for (const [platform, channelFile, extension, artifact] of [
  ['win32', 'canary.yml', 'exe', 'win-x64.exe'],
  ['darwin', 'canary-mac.yml', 'zip', 'mac-arm64.zip'],
  ['linux', 'canary-linux.yml', 'AppImage', 'linux-x86_64.AppImage'],
]) {
  void test(`${platform} Canary resolves its own installer and blockmaps from the CDN`, async (t) => {
    const previousArch = process.env.TEST_UPDATER_ARCH;
    process.env.TEST_UPDATER_ARCH = 'x64';
    t.after(() => {
      if (previousArch === undefined) delete process.env.TEST_UPDATER_ARCH;
      else process.env.TEST_UPDATER_ARCH = previousArch;
    });
    const oldVersion = '1.0.5-canary.107.1.gaaaaaaaa';
    const newVersion = '1.0.5-canary.108.1.gbbbbbbbb';
    const filename = (version) => `KimiCodeCanary-${version}-${artifact}`;
    const requests = [];
    const manifest = `version: ${newVersion}\nfiles:\n  - url: binaries/${newVersion}/${filename(newVersion)}\n    sha512: checksum\npath: binaries/${newVersion}/${filename(newVersion)}\n`;
    const provider = new GenericProvider(
      { url: 'https://code.kimi.com/kimi-code/desktop/', channel: 'canary' },
      { channel: null, isAddNoCacheQuery: false },
      { platform, executor: { request: async (options) => { requests.push(options); return manifest; } } },
    );
    const info = await provider.getLatestVersion();
    assert.equal(new URL(requests[0].protocol + '//' + requests[0].hostname + requests[0].path).pathname, `/kimi-code/desktop/${channelFile}`);
    const file = findFile(provider.resolveFiles(info), extension);
    assert.equal(file.url.href, `https://code.kimi.com/kimi-code/desktop/binaries/${newVersion}/${filename(newVersion)}`);
    assert.deepEqual(
      provider.getBlockMapFiles(file.url, oldVersion, newVersion).map((url) => url.href),
      [oldVersion, newVersion].map((version) => `https://code.kimi.com/kimi-code/desktop/binaries/${version}/${filename(version)}.blockmap`),
    );
  });
}

for (const [type, suffix] of [['Deb', 'linux-amd64.deb'], ['Rpm', 'linux-x86_64.rpm']]) {
  void test(`${type} updater is active without APPIMAGE and selects its own package`, async (t) => {
    const previousAppImage = process.env.APPIMAGE;
    const previousArch = process.env.TEST_UPDATER_ARCH;
    delete process.env.APPIMAGE;
    process.env.TEST_UPDATER_ARCH = 'x64';
    t.after(() => {
      if (previousAppImage === undefined) delete process.env.APPIMAGE;
      else process.env.APPIMAGE = previousAppImage;
      if (previousArch === undefined) delete process.env.TEST_UPDATER_ARCH;
      else process.env.TEST_UPDATER_ARCH = previousArch;
    });
    const Updater = require(`electron-updater/out/${type}Updater`)[`${type}Updater`];
    const updater = new Updater(null, { version: '1.1.0-canary.1', isPackaged: true });
    assert.equal(updater.isUpdaterActive(), true);
    const version = '1.1.0-canary.2';
    const files = ['linux-x86_64.AppImage', 'linux-amd64.deb', 'linux-x86_64.rpm'].map((ending) => ({
      url: `binaries/${version}/KimiCodeCanary-${version}-${ending}`, sha512: 'checksum',
    }));
    const provider = new GenericProvider(
      { url: 'https://code.kimi.com/kimi-code/desktop/', channel: 'canary' },
      updater,
      { platform: 'linux', executor: null },
    );
    let selected;
    updater.executeDownload = async (options) => { selected = options; return []; };
    await updater.doDownloadUpdate({ updateInfoAndProvider: { provider, info: { version, files } } });
    assert.equal(selected.fileExtension, type.toLowerCase());
    assert.ok(selected.fileInfo.url.pathname.endsWith(suffix));
  });
}
