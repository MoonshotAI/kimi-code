import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

import type { Request, Response } from 'express';

import { useInject } from '@moonshot-ai/agent-core/kernel/index';

import type { OsFsPort } from '#/features/os/host/index';
import {
  KIMI_CODE_PLUGIN_MARKETPLACE_URL,
  KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV,
  PluginError,
  PluginRef,
  computeUpdateStatus,
  parsePluginMarketplace,
  readPluginMarketplace,
  withLatestVersions,
  type PluginFace,
  type PluginMarketplace,
  type PluginSummary,
} from '#/features/plugin/index';

import { useHttpRoute } from '../scope';
import { parseActionSuffix } from '../route/action-suffix';
import { ErrorCode, param, sendErr, sendOk } from '../route/http';

const PLUGIN_ACTIONS = ['enable', 'disable', 'remove'] as const;

const MARKETPLACE_FETCH_TIMEOUT_MS = 10_000;

const localFs = { readText: (path: string) => readFile(path, 'utf8') } as OsFsPort;

export function usePluginRoutes(prefix: string): void {
  const face = useInject(PluginRef);

  const pluginFacade = (request: Request, response: Response): PluginFace | undefined => {
    if (face.value === undefined) {
      sendErr(
        request,
        response,
        ErrorCode.PLUGIN_UNAVAILABLE,
        'plugins are unavailable (plugin feature is not installed)',
      );
    }
    return face.value;
  };

  useHttpRoute({
    id: 'plugins.list',
    method: 'GET',
    path: `${prefix}/plugins`,
    handler: async (request, response) => {
      const facade = pluginFacade(request, response);
      if (facade === undefined) return;
      try {
        sendOk(request, response, { plugins: await facade.listPlugins() });
      } catch (error) {
        if (sendPluginErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useHttpRoute({
    id: 'plugins.marketplace',
    method: 'GET',
    path: `${prefix}/plugins/marketplace`,
    handler: async (request, response) => {
      const facade = pluginFacade(request, response);
      if (facade === undefined) return;
      const source = process.env[KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV] ?? KIMI_CODE_PLUGIN_MARKETPLACE_URL;
      let marketplace: PluginMarketplace;
      let raw: { readonly raw: string; readonly location: Parameters<typeof parsePluginMarketplace>[1] };
      try {
        raw = await readPluginMarketplace(localFs, {
          source,
          workDir: process.cwd(),
          home: homedir(),
          fetchImpl: fetchWithTimeout,
        });
      } catch (error) {
        sendErr(
          request,
          response,
          ErrorCode.INTERNAL_ERROR,
          `Plugin marketplace is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      try {
        marketplace = parsePluginMarketplace(raw.raw, raw.location);
      } catch (error) {
        sendErr(
          request,
          response,
          ErrorCode.INTERNAL_ERROR,
          `Plugin marketplace returned an invalid catalog: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      try {
        marketplace = await withLatestVersions(marketplace, fetchWithTimeout);
      } catch (error) {
        sendErr(
          request,
          response,
          ErrorCode.INTERNAL_ERROR,
          `Plugin marketplace is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      let installed: readonly PluginSummary[] = [];
      try {
        installed = await facade.listPlugins();
      } catch (error) {
        if (sendPluginErr(request, response, error)) return;
        throw error;
      }
      const byId = new Map(installed.map((plugin) => [plugin.id, plugin]));
      const entries = marketplace.plugins.map((entry) => {
        const record = byId.get(entry.id);
        const updateAvailable =
          computeUpdateStatus(entry.version, record?.version, record !== undefined).kind === 'update';
        return {
          id: entry.id,
          tier: entry.tier ?? 'third-party',
          displayName: entry.displayName,
          description: entry.description,
          homepage: entry.homepage,
          keywords: entry.keywords === undefined ? undefined : [...entry.keywords],
          version: entry.version,
          source: entry.source,
          installed:
            record === undefined
              ? undefined
              : { enabled: record.enabled, version: record.version },
          updateAvailable: updateAvailable ? true : undefined,
        };
      });
      sendOk(request, response, { entries });
    },
  });

  useHttpRoute({
    id: 'plugins.install',
    method: 'POST',
    path: `${prefix}/plugins`,
    handler: async (request, response) => {
      const facade = pluginFacade(request, response);
      if (facade === undefined) return;
      const body = request.body;
      const source =
        body !== null && typeof body === 'object' && !Array.isArray(body)
          ? (body as { source?: unknown }).source
          : undefined;
      if (typeof source !== 'string' || source.length === 0) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'source is required');
        return;
      }
      try {
        sendOk(request, response, await facade.installPlugin(source));
      } catch (error) {
        if (sendPluginErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useHttpRoute({
    id: 'plugins.action',
    method: 'POST',
    path: `${prefix}/plugins/:tail`,
    handler: async (request, response) => {
      const tail = param(request, 'tail');
      if (tail === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'plugin id is required');
        return;
      }
      const facade = pluginFacade(request, response);
      if (facade === undefined) return;
      if (tail === 'check-updates') {
        try {
          sendOk(request, response, { updates: await facade.checkUpdates() });
        } catch (error) {
          if (sendPluginErr(request, response, error)) return;
          throw error;
        }
        return;
      }
      const parsed = parseActionSuffix({ tail, allowedActions: PLUGIN_ACTIONS, resourceLabel: 'plugin' });
      if (parsed.kind !== 'action') {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`,
        );
        return;
      }
      try {
        if (parsed.action === 'enable') {
          await facade.setPluginEnabled(parsed.id, true);
        } else if (parsed.action === 'disable') {
          await facade.setPluginEnabled(parsed.id, false);
        } else {
          await facade.removePlugin(parsed.id);
        }
      } catch (error) {
        if (sendPluginErr(request, response, error)) return;
        throw error;
      }
      sendOk(request, response, { ok: true });
    },
  });
}

function sendPluginErr(request: Request, response: Response, error: unknown): boolean {
  if (error instanceof PluginError) {
    if (error.code === 'plugin.not_found') {
      sendErr(request, response, ErrorCode.PLUGIN_NOT_FOUND, error.message);
      return true;
    }
    if (error.code === 'fs.path_not_found') {
      sendErr(request, response, ErrorCode.FS_PATH_NOT_FOUND, error.message);
      return true;
    }
    if (error.code === 'plugin.load_failed' || error.code === 'validation.failed') {
      sendErr(request, response, ErrorCode.VALIDATION_FAILED, error.message);
      return true;
    }
  }
  sendErr(
    request,
    response,
    ErrorCode.INTERNAL_ERROR,
    error instanceof Error ? error.message : String(error),
  );
  return true;
}

function fetchWithTimeout(...args: Parameters<typeof fetch>) {
  const [input, init] = args;
  return fetch(input, { ...init, signal: AbortSignal.timeout(MARKETPLACE_FETCH_TIMEOUT_MS) });
}
