import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const dist = fileURLToPath(new URL('./dist', import.meta.url));
await mkdir(dist, { recursive: true });

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

if (process.platform === 'darwin') {
  const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx12.0`;
  const nodeInclude = join(dirname(await realpath(process.execPath)), '..', 'include', 'node');
  run('xcrun', [
    'clang++', '-std=c++17', '-O2', '-fobjc-arc', '-bundle', '-undefined', 'dynamic_lookup',
    '-target', target, '-DNAPI_VERSION=8', '-I', nodeInclude, '-framework', 'AppKit',
    'macos/overlay.mm', '-o', 'dist/screenshot-overlay.node',
  ]);
  run('xcrun', [
    'clang++', '-std=c++17', '-O2', '-fobjc-arc', '-bundle', '-undefined', 'dynamic_lookup',
    '-target', target, '-DNAPI_VERSION=8', '-I', nodeInclude,
    '-framework', 'AppKit', '-weak_framework', 'ScreenCaptureKit',
    'macos/capture.mm', '-o', 'dist/screenshot-capture.node',
  ]);
  run('xcrun', [
    'swiftc',
    '-target', target,
    'macos/main.swift',
    '-O',
    '-framework',
    'AppKit',
    '-framework',
    'CoreGraphics',
    '-framework',
    'Foundation',
    '-o',
    'dist/screenshot-window-list',
  ]);
} else if (process.platform === 'win32') {
  const clArgs = [
    '/nologo',
    '/std:c++20',
    '/O2',
    '/EHsc',
    '/Fodist/main.obj',
    'windows/main.cpp',
    '/link',
    'user32.lib',
    'dwmapi.lib',
    'ole32.lib',
    'uuid.lib',
    '/out:dist/screenshot-window-list.exe',
  ];
  const vswhere = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
  const probe = spawnSync(vswhere, [
    '-latest', '-products', '*',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath',
  ], { encoding: 'utf8' });
  const installationPath = probe.error || probe.status !== 0 ? '' : probe.stdout.trim();
  const vcvars = installationPath === '' ? null : join(installationPath, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (vcvars !== null && existsSync(vcvars)) {
    const script = join(dist, 'build-msvc.cmd');
    await writeFile(script, `@echo off\r\ncall "${vcvars}"\r\nif errorlevel 1 exit /b 1\r\ncl ${clArgs.join(' ')}\r\n`);
    run('cmd.exe', ['/d', '/c', script]);
  } else {
    run('cl', clArgs);
  }
}
