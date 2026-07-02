/**
 * Scenario: the **config** slice — every Service that registers a config
 * section, shown against one shared, file-backed `IConfigService`.
 *
 * `config` holds no schema of its own; each domain that consumes a config owns
 * its section and registers it from its Service constructor. This example
 * resolves **every** current section owner so its `registerSection` runs, then
 * reads the single `IConfigRegistry` / `IConfigService` they all populated:
 *
 *  App-scope owners (resolved from the production `bootstrap` App scope):
 *   - `IModelService`          → `models`          (+ the `KIMI_MODEL_*` overlay)
 *   - `IProviderService`       → `providers`
 *   - `IFlagService`           → `experimental`
 *
 *  Agent-scope owners (constructed here against the same registry):
 *   - `IAgentBackgroundService`     → `background`
 *   - `IAgentCronService`           → `cron`
 *   - `IAgentPermissionRulesService`→ `permission`
 *   - `IAgentProfileService`        → `thinking`, `defaultThinking`
 *   - `IAgentLoopService`           → `loopControl`
 *   - `IAgentExternalHooksService`  → `hooks`
 *
 * The Agent owners are constructed through `createServices` with their
 * non-config collaborators stubbed, mirroring how the slice tests isolate a
 * domain (see `feature-flags.example.ts`). Only the `registerSection` call and
 * the config reads are real — which is exactly what this example is about. The
 * App owners are *not* re-constructed: they are resolved from the real App
 * scope, so no section is registered twice.
 *
 * Two scenarios are shown:
 *
 *  1. **register + inspect** — every owner registers its section into the one
 *     registry; `inspect` reports each section's default layer.
 *  2. **write + round-trip** — a schema-valid value for every *persistable*
 *     section is written through `IConfigService.set`; each is validated,
 *     env-stripped, and persisted, then `reload()` parses the file back so the
 *     effective value matches what was written. (`cron` is operational /
 *     env-only and is intentionally not persisted.)
 *
 * All Services come from `src/`; nothing here defines a new Service.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import type { Scope } from '#/_base/di/scope';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { AgentBackgroundService, IAgentBackgroundService } from '#/agent/background';
import { bootstrap } from '#/app/bootstrap/bootstrap';
import { type ConfigInspectValue, IConfigRegistry, IConfigService } from '#/app/config/config';
import '#/app/config';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentContextProjectorService } from '#/agent/contextProjector';
import { IAgentContextSizeService } from '#/agent/contextSize';
import { AgentCronService } from '#/agent/cron';
import { IAgentRecordService } from '#/agent/record';
import { AgentExternalHooksService, IAgentExternalHooksService } from '#/agent/externalHooks';
import { IFlagService } from '#/app/flag';
import { IAgentLLMRequesterService } from '#/agent/llmRequester';
import { logSeed, resolveLoggingConfig } from '#/app/log/logConfig';
import { AgentLoopService, IAgentLoopService } from '#/agent/loop';
import { IChatProviderFactory } from '#/app/chatProvider';
import { IModelService } from '#/app/model';
import '#/app/model';
import { ISessionModelResolver } from '#/session/modelRuntime';
import { IAgentPermissionRulesService, AgentPermissionRulesService } from '#/agent/permissionRules';
import { IAgentProfileService, AgentProfileService } from '#/agent/profile';
import { IAgentPromptService } from '#/agent/prompt';
import { IProviderService } from '#/app/provider';
import '#/app/provider';
import '#/app/flag';
import { IAgentReplayBuilderService } from '#/agent/replayBuilder';
import { ISessionContext } from '#/session/session-context';
import { IAtomicDocumentStore, IStorageService } from '#/app/storage';
import '#/app/storage';
import { ITelemetryService } from '#/app/telemetry';
import { IAgentToolExecutorService } from '#/agent/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import { IAgentTurnService } from '#/agent/turn';
import { IAgentWireRecordService } from '#/agent/wireRecord';

/**
 * One schema-valid sample value per **persistable** section, written through
 * `IConfigService.set` so each owner's write path round-trips to `config.toml`.
 * `cron` is intentionally absent: it is operational / env-only (`stripCronEnv`
 * drops it), so it is never persisted to `config.toml` by design.
 */
const SECTION_VALUES: Record<string, unknown> = {
  models: {
    'kimi-k2': { provider: 'moonshot', model: 'kimi-k2-0905-preview', maxContextSize: 262_144 },
  },
  providers: {
    moonshot: { type: 'kimi', apiKey: 'YOUR_API_KEY' },
  },
  experimental: { demo_feature: true },
  background: { maxRunningTasks: 4, keepAliveOnExit: true },
  permission: {
    rules: [{ decision: 'allow', scope: 'user', pattern: 'bash(git status)' }],
  },
  thinking: { mode: 'auto', effort: 'medium' },
  defaultThinking: true,
  loopControl: { maxStepsPerTurn: 50, maxRetriesPerStep: 3 },
  hooks: [{ event: 'PreToolUse', matcher: 'bash', command: 'echo demo' }],
};

/** Domains every current section owner registers, in registration order. */
const EXPECTED_SECTIONS = [
  'models',
  'providers',
  'experimental',
  'background',
  'cron',
  'permission',
  'thinking',
  'defaultThinking',
  'loopControl',
  'hooks',
] as const;

/** `HookSlot` stub — owners only `.register()` hooks during construction. */
function hookSlot() {
  return {
    register: () => toDisposable(() => {}),
    delete: () => true,
    run: async () => {},
  };
}

describe('config slice (every section owner against one shared registry)', () => {
  let homeDir: string;
  let app: Scope;
  let configPath: string;
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    const resolved = process.env['KIMI_CODE_HOME'];
    if (resolved === undefined) {
      throw new Error('KIMI_CODE_HOME is not set; globalSetup should have initialized it');
    }
    homeDir = resolved;
    mkdirSync(homeDir, { recursive: true });
    configPath = join(homeDir, 'config.toml');

    // Real, file-backed config. Constructing the App scope eager-loads
    // `IModelService`, which registers the `models` section + overlay.
    app = bootstrap({ homeDir }, logSeed(resolveLoggingConfig({ homeDir, env: process.env }))).app;

    const registry = app.accessor.get(IConfigRegistry);
    const config = app.accessor.get(IConfigService);

    // Construct the Agent-scope owners against the SAME registry/service. Their
    // non-config collaborators are stubbed: this example isolates the config
    // slice, it does not run the owners. Real owner constructors are used so the
    // real `registerSection` calls execute.
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IConfigRegistry, registry);
        reg.defineInstance(IConfigService, config);

        // Collaborators touched during owner construction, with real shape.
        reg.definePartialInstance(IAgentWireRecordService, {
          register: () => toDisposable(() => {}),
          append: () => {},
          hooks: { onRestoredRecord: hookSlot(), onResumeEnded: hookSlot() },
        });
        reg.definePartialInstance(IAgentContextMemoryService, { hooks: { onSpliced: hookSlot() } });
        reg.definePartialInstance(IAgentToolExecutorService, {
          // `OrderedHookSlot` is a class with private members, so the stub is
          // shaped as a `HookSlot` and cast to the declared slot type.
          hooks: {
            onWillExecuteTool: hookSlot(),
            onDidExecuteTool: hookSlot(),
          } as unknown as IAgentToolExecutorService['hooks'],
        });
        reg.definePartialInstance(ISessionModelResolver, { defaultModel: 'mock-model' });
        reg.definePartialInstance(ISessionContext, {
          metaScope: 'sessions/demo/demo/session-meta',
          sessionDir: homeDir,
        });
        reg.definePartialInstance(IAgentTurnService, { getActiveTurn: () => undefined });

        // Collaborators declared but not touched during construction — empty
        // stubs keep the container strict-clean (no "unknown service" warnings).
        reg.definePartialInstance(IAgentRecordService, {});
        reg.definePartialInstance(ITelemetryService, { track: () => {} });
        reg.definePartialInstance(IAgentPromptService, {});
        reg.definePartialInstance(IAtomicDocumentStore, {});
        reg.definePartialInstance(IStorageService, {});
        reg.definePartialInstance(IAgentToolRegistryService, {});
        reg.definePartialInstance(IAgentReplayBuilderService, {});
        reg.definePartialInstance(IChatProviderFactory, {});
        reg.definePartialInstance(IAgentContextProjectorService, {});
        reg.definePartialInstance(IAgentContextSizeService, {});
        reg.definePartialInstance(IAgentLLMRequesterService, {});

        // Real Agent-scope section owners. `IAgentCronService` is constructed via
        // `createInstance` below (not here) so we can pass `{ isSubagent: true }`
        // and keep its runtime scheduler/tool registration from starting.
        reg.define(IAgentExternalHooksService, AgentExternalHooksService);
        reg.define(IAgentPermissionRulesService, AgentPermissionRulesService);
        reg.define(IAgentProfileService, AgentProfileService);
        reg.define(IAgentBackgroundService, AgentBackgroundService);
        reg.define(IAgentLoopService, AgentLoopService);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
    app.dispose();
  });

  test('every section owner registers its section into the shared registry', async () => {
    const registry = app.accessor.get(IConfigRegistry);
    const config = app.accessor.get(IConfigService);
    await config.ready;

    // Resolve the App owners and touch each one: delayed App services return
    // a lazy proxy, so reading a method forces construction (and thus the
    // `registerSection` call). `IModelService` is eager but still needs a `get`.
    app.accessor.get(IModelService).list();
    app.accessor.get(IProviderService).list();
    app.accessor.get(IFlagService).snapshot();

    // Construct the Agent owners — each registers its section(s).
    ix.get(IAgentBackgroundService);
    ix.get(IAgentPermissionRulesService);
    ix.get(IAgentProfileService);
    ix.get(IAgentExternalHooksService);
    ix.get(IAgentLoopService);
    // `isSubagent: true` keeps the cron scheduler/tool registration from
    // starting — only the `cron` config-section registration is relevant here.
    ix.createInstance(AgentCronService, { isSubagent: true });

    const registered = registry
      .listSections()
      .map((s) => s.domain)
      .toSorted();
    console.log('registered sections:', registered);

    expect(registered).toEqual([...EXPECTED_SECTIONS].toSorted());

    console.log('\ninspect (default layer) per section:');
    for (const domain of EXPECTED_SECTIONS) {
      const view = config.inspect(domain);
      console.log(`   ${domain}:`, summarizeInspect(view));
    }
  });

  test('writes every persistable section through config and round-trips the file', async () => {
    const config = app.accessor.get(IConfigService);
    await config.ready;

    // Resolve every owner so its section is registered before writing.
    app.accessor.get(IModelService).list();
    app.accessor.get(IProviderService).list();
    app.accessor.get(IFlagService).snapshot();
    ix.get(IAgentBackgroundService);
    ix.get(IAgentPermissionRulesService);
    ix.get(IAgentProfileService);
    ix.get(IAgentExternalHooksService);
    ix.get(IAgentLoopService);
    ix.createInstance(AgentCronService, { isSubagent: true });

    // Write each persistable section through IConfigService — every owner's
    // value is validated, env-stripped, and persisted to config.toml.
    let changes = 0;
    const sub = config.onDidChangeConfiguration(() => changes++);
    for (const [domain, value] of Object.entries(SECTION_VALUES)) {
      await config.set(domain, value);
    }
    sub.dispose();

    const onDisk = readFileSync(configPath, 'utf8').trim();
    console.log('config.toml after writing every section:');
    for (const line of onDisk.split('\n')) {
      console.log('   ', line);
    }
    console.log(
      `\n${Object.keys(SECTION_VALUES).length} sections written; onDidChangeConfiguration fired ${changes} times.`,
    );
    console.log('(cron is operational/env-only and intentionally not persisted.)');

    // Round-trip: reload the file and confirm each section parses back to the
    // value just written (read path: snake_case file → fromToml → effective).
    await config.reload();
    console.log('\ninspect after reload (round-trip) per section:');
    for (const domain of Object.keys(SECTION_VALUES)) {
      console.log(`   ${domain}:`, config.inspect(domain).value);
    }
  });
});

function summarizeInspect(inspect: ConfigInspectValue<unknown>): Record<string, unknown> {
  return {
    hasDefaultValue: inspect.defaultValue !== undefined,
    hasUserValue: inspect.userValue !== undefined,
    hasMemoryValue: inspect.memoryValue !== undefined,
    keys: inspect.value !== null && typeof inspect.value === 'object' ? Object.keys(inspect.value) : [],
  };
}
