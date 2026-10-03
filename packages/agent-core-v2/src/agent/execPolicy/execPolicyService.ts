

import { join } from 'node:path';

import {
  BUILTIN_RULES,
  RulesSyntaxError,
  evaluateHost,
  evaluateSegments,
  parseRulesFile,
} from '@moonshot-ai/exec-policy';
import type {
  CommandVerdict,
  ExecRule,
  RuleSource,
  SegmentDecision,
  UnsourcedRule,
} from '@moonshot-ai/exec-policy';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IBashParserService } from '#/app/bashParser/bashParser';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  IAgentExecPolicyService,
  type ExecPolicyEvaluation,
} from './execPolicy';
import { extractSegments, type CommandSegment } from './segmentExtractor';

const PARSE_OPTIONS = { timeoutMs: 500, maxNodes: 10_000 } as const;

const RULES_DIR_NAME = 'rules.d';
const RULES_FILE_SUFFIX = '.rules';

interface LayerDir {
  readonly dir: string;
  readonly source: RuleSource;
}

export class AgentExecPolicyService implements IAgentExecPolicyService {
  declare readonly _serviceBrand: undefined;

  private readonly sessionRules: ExecRule[] = [];
  private fileRules: Promise<readonly ExecRule[]> | undefined;

  constructor(
    @IBashParserService private readonly bashParser: IBashParserService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ISessionContext private readonly ctx: ISessionContext,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {}

  async evaluate(command: string): Promise<ExecPolicyEvaluation> {
    const segments = extractSegments(command, 0, (source) =>
      this.bashParser.parse(source, PARSE_OPTIONS),
    );
    if (segments === undefined || segments.includes(null)) {
      const verdict: CommandVerdict = 'unanalyzable';
      const empty: ExecPolicyEvaluation = {
        verdict,
        segments: [],
        segmentCount: segments?.length ?? 0,
      };
      return empty;
    }
    const rules = [...(await this.loadFileRules()), ...this.sessionRules];
    const result = evaluateSegments(rules, segments);
    const winning = result.segments.find((s) => s.decision === result.verdict);
    return {
      verdict: result.verdict,
      segments: result.segments,
      matchedRule: winning?.matchedRule,
      segmentCount: segments.length,
    };
  }

  async evaluateHost(host: string, protocol?: string): Promise<SegmentDecision> {
    const rules = [...(await this.loadFileRules()), ...this.sessionRules];
    return evaluateHost(rules, host, protocol);
  }

  addSessionRule(rule: UnsourcedRule): void {
    this.sessionRules.push({ ...rule, source: 'session-runtime' } as ExecRule);
  }

  private layerDirs(): readonly LayerDir[] {
    const dirs: LayerDir[] = [
      {
        dir: join(this.bootstrap.homeDir, RULES_DIR_NAME),
        source: 'user',
      },
      {
        dir: join(this.ctx.cwd, '.kimi-code', RULES_DIR_NAME),
        source: 'project',
      },
    ];
    if (this.env.pathClass === 'posix') {
      dirs.unshift({ dir: join('/etc', 'kimi-code', RULES_DIR_NAME), source: 'managed' });
    }
    return dirs;
  }

  private loadFileRules(): Promise<readonly ExecRule[]> {
    this.fileRules ??= this.readLayerDirs();
    return this.fileRules;
  }

  private async readLayerDirs(): Promise<readonly ExecRule[]> {
    const rules: ExecRule[] = [...BUILTIN_RULES];
    for (const { dir, source } of this.layerDirs()) {
      let entries;
      try {
        entries = await this.fs.readdir(dir);
      } catch {
        continue;
      }
      const files = entries
        .filter((e) => e.isFile && e.name.endsWith(RULES_FILE_SUFFIX))
        .map((e) => e.name)
        .toSorted();
      for (const name of files) {
        const path = join(dir, name);
        try {
          const text = await this.fs.readText(path);
          rules.push(...parseRulesFile(text, source));
        } catch (error) {
          const detail =
            error instanceof RulesSyntaxError
              ? `syntax:${error.line}:${error.column}`
              : 'io';
          this.log.warn(`exec-policy: skipping ${path} — ${detail}`);
          const layer: string = source;
          this.telemetry.track2('exec_policy_rules_error', {
            layer,
            error_kind: detail,
          });
        }
      }
    }
    return rules;
  }
}

export type { CommandSegment };

registerScopedService(
  LifecycleScope.Agent,
  IAgentExecPolicyService,
  AgentExecPolicyService,
  ScopeActivation.OnScopeCreated,
  'execPolicy',
);
