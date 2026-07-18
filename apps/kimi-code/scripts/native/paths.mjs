import { resolve } from 'node:path';

export const appRoot = resolve(import.meta.dirname, '..', '..');

export function targetTriple({ platform = process.platform, arch = process.arch, env = process.env } = {}) {
  return env.KIMI_CODE_BUILD_TARGET ?? `${platform}-${arch}`;
}

export function executableName(platform = process.platform) {
  return platform === 'win32' ? 'kimi.exe' : 'kimi';
}

export function nativeDistRoot() {
  return resolve(appRoot, 'dist-native');
}

export function nativeIntermediatesDir() {
  return resolve(nativeDistRoot(), 'intermediates');
}

export function nativeBinDir(target = targetTriple()) {
  return resolve(nativeDistRoot(), 'bin', target);
}

export function nativeBinPath(target = targetTriple(), platform = process.platform) {
  return resolve(nativeBinDir(target), executableName(platform));
}

export function nativeJsBundlePath() {
  return resolve(nativeIntermediatesDir(), 'main.cjs');
}

export function nativeBlobPath() {
  return resolve(nativeIntermediatesDir(), 'kimi.blob');
}

export function nativeSeaConfigPath() {
  return resolve(nativeIntermediatesDir(), 'sea-config.json');
}

export function nativeManifestDir(target = targetTriple()) {
  return resolve(nativeIntermediatesDir(), 'native-assets', target);
}

export function nativeArtifactsDir() {
  return resolve(nativeDistRoot(), 'artifacts');
}

export function nativeSmokeHome() {
  return resolve(nativeDistRoot(), 'smoke-home');
}

export function nativeManifestKey(target = targetTriple()) {
  return `native/${target}/manifest.json`;
}
