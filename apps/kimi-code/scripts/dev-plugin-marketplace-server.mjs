#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import yazl from 'yazl';

import { readPluginManifestVersion } from './plugin-manifest-version.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../../..');
const DEFAULT_PLUGINS_ROOT = resolve(REPO_ROOT, 'plugins');

export async function startPluginMarketplaceServer(options = {}) {
  const pluginsRoot = resolve(
    options.pluginsRoot ?? process.env.KIMI_CODE_PLUGIN_MARKETPLACE_DEV_ROOT ?? DEFAULT_PLUGINS_ROOT,
  );
  const host = options.host ?? process.env.KIMI_CODE_PLUGIN_MARKETPLACE_DEV_HOST ?? '127.0.0.1';
  const port = Number(options.port ?? process.env.KIMI_CODE_PLUGIN_MARKETPLACE_DEV_PORT ?? 0);
  const server = createServer((req, res) => {
    void handleRequest(req, res, pluginsRoot);
  });

  await new Promise((resolveStarted, rejectStarted) => {
    const onError = (error) => {
      rejectStarted(error);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolveStarted();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Plugin marketplace dev server did not bind to a TCP port.');
  }

  const marketplaceUrl = `http://${host}:${address.port}/marketplace.json`;
  return {
    server,
    pluginsRoot,
    marketplaceUrl,
    close: () =>
      new Promise((resolveClosed, rejectClosed) => {
        server.close((error) => {
          if (error !== undefined) rejectClosed(error);
          else resolveClosed();
        });
      }),
  };
}

async function handleRequest(req, res, pluginsRoot) {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  try {
    if (pathname === '/' || pathname === '/marketplace.json') {
      await serveMarketplaceJson(res, pluginsRoot, method === 'HEAD');
      return;
    }
    if (pathname.endsWith('.zip')) {
      await servePluginZip(res, pluginsRoot, pathname, method === 'HEAD');
      return;
    }
    await serveStaticFile(res, pluginsRoot, pathname, method === 'HEAD');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(message);
  }
}

async function serveMarketplaceJson(res, pluginsRoot, headOnly) {
  const file = resolveInsideRoot(pluginsRoot, 'marketplace.json');
  const raw = await readFile(file, 'utf8');
  const body = Buffer.from(
    JSON.stringify(await rewriteMarketplaceJson(raw, pluginsRoot), null, 2) + '\n',
  );
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.byteLength),
  });
  res.end(headOnly ? undefined : body);
}

async function rewriteMarketplaceJson(raw, pluginsRoot) {
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) return parsed;

  const plugins = await Promise.all(
    parsed.plugins.map(async (entry) => {
      if (!isRecord(entry) || typeof entry.source !== 'string') return entry;
      if (!isLocalRelativeSource(entry.source)) return entry;
      const sourcePath = resolveInsideRoot(pluginsRoot, entry.source);
      if (!(await isDirectory(sourcePath))) return entry;
      // Stamp the version from the plugin's real manifest so "latest" stays truthful.
      const version = await readPluginManifestVersion(sourcePath);
      const withVersion = version !== undefined ? { ...entry, version } : entry;
      return { ...withVersion, source: withZipExtension(withVersion.source) };
    }),
  );

  return { ...parsed, plugins };
}

async function servePluginZip(res, pluginsRoot, pathname, headOnly) {
  const zipRel = pathname.replace(/^\/+/, '');
  const sourceRel = zipRel.slice(0, -'.zip'.length);
  const sourceRoot = resolveInsideRoot(pluginsRoot, sourceRel);
  if (!(await isDirectory(sourceRoot))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/zip' });
  if (headOnly) {
    res.end();
    return;
  }

  const zipfile = new yazl.ZipFile();
  zipfile.outputStream.on('error', (error) => {
    res.destroy(error);
  });
  zipfile.outputStream.pipe(res);
  await addDirectoryToZip(zipfile, sourceRoot, basename(sourceRoot));
  zipfile.end();
}

async function serveStaticFile(res, pluginsRoot, pathname, headOnly) {
  const file = resolveInsideRoot(pluginsRoot, pathname.replace(/^\/+/, ''));
  const info = await stat(file).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentType(file),
    'Content-Length': String(info.size),
  });
  if (headOnly) {
    res.end();
    return;
  }
  createReadStream(file).on('error', (error) => res.destroy(error)).pipe(res);
}

async function addDirectoryToZip(zipfile, root, zipRoot) {
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolutePath = resolve(root, entry.name);
    const zipPath = `${zipRoot}/${relative(root, absolutePath).replaceAll(sep, '/')}`;
    if (entry.isDirectory()) {
      await addDirectoryToZip(zipfile, absolutePath, zipPath);
    } else if (entry.isFile()) {
      zipfile.addFile(absolutePath, zipPath);
    }
  }
}

function resolveInsideRoot(root, input) {
  const resolved = resolve(root, input);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Path escapes plugin marketplace root: ${input}`);
  }
  return resolved;
}

function isLocalRelativeSource(source) {
  const trimmed = source.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith('http://') &&
    !trimmed.startsWith('https://') &&
    !trimmed.startsWith('file://') &&
    !trimmed.startsWith('/') &&
    !trimmed.startsWith('~/') &&
    trimmed !== '~'
  );
}

function withZipExtension(source) {
  const trimmed = source.trim().replace(/\/+$/, '');
  return extname(trimmed) === '.zip' ? trimmed : `${trimmed}.zip`;
}

async function isDirectory(path) {
  return (await stat(path).catch(() => undefined))?.isDirectory() === true;
}

function contentType(path) {
  switch (extname(path)) {
    case '.json':
      return 'application/json; charset=utf-8';
    case '.mjs':
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.md':
      return 'text/markdown; charset=utf-8';
    case '.txt':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const started = await startPluginMarketplaceServer();
  console.error(`Plugin marketplace dev server: ${started.marketplaceUrl}`);
  console.error(`Serving: ${started.pluginsRoot}`);
}
