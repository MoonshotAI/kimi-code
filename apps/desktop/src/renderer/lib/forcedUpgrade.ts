import { computed, ref, watch, type Ref } from 'vue';
import { lt, valid } from 'semver';
import type { UpdateCheckResult, UpdateStatus } from '@moonshot-ai/app-client/composables';
import { track } from './track';

export type ForcedUpgradePhase = 'idle' | 'prompt' | 'checking' | 'downloading' | 'downloaded' | 'installing' | 'error' | 'skipped';
export type ForcedUpgradeErrorStage = 'check' | 'download' | 'install';

interface ForcedUpgradeDeps {
  currentVersion: string;
  supported: boolean;
  status: Ref<UpdateStatus>;
  fetchPolicy: () => Promise<unknown>;
  check: () => Promise<UpdateCheckResult>;
  download: () => void;
  install: () => Promise<void>;
  now?: () => number;
}

export function isForcedUpgradeRequired(currentVersion: string, minimumVersion: unknown): minimumVersion is string {
  if (typeof minimumVersion !== 'string') return false;
  const current = valid(currentVersion);
  const minimum = valid(minimumVersion);
  return current !== null && minimum !== null && lt(current, minimum);
}

export function desktopMinimumVersion(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = (raw as Record<string, unknown>)['desktopMinVersion'];
  return typeof value === 'string' && valid(value) !== null ? value : null;
}

export function createForcedUpgradeController(deps: ForcedUpgradeDeps) {
  const phase = ref<ForcedUpgradePhase>('idle');
  const minimumVersion = ref('');
  const targetVersion = ref<string | undefined>();
  const errorMessage = ref('');
  const errorStage = ref<ForcedUpgradeErrorStage>('check');
  const remainingSeconds = ref(10);
  const attempt = ref(0);
  const now = deps.now ?? Date.now;
  const channel: 'stable' | 'canary' = deps.currentVersion.includes('-canary.') ? 'canary' : 'stable';
  const visible = computed(() => phase.value !== 'idle' && phase.value !== 'skipped');
  const busy = computed(() => phase.value === 'checking' || phase.value === 'downloading' || phase.value === 'installing');
  let skipAvailableAt = 0;
  let shownAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastErrorClass: string | undefined;

  const properties = () => ({
    client: 'desktop' as const,
    current_version: deps.currentVersion,
    minimum_version: minimumVersion.value,
    target_version: targetVersion.value,
    channel,
  });

  function transition(next: ForcedUpgradePhase, nextErrorClass?: string): void {
    if (phase.value === next && nextErrorClass === undefined) return;
    const previous = phase.value;
    phase.value = next;
    if (next !== 'error') lastErrorClass = undefined;
    else lastErrorClass = nextErrorClass;
    if (next === 'checking' || next === 'downloading' || next === 'downloaded' || next === 'installing' || next === 'error') {
      track('forced_upgrade_state_changed', {
        ...properties(),
        from_state: previous,
        to_state: next,
        error_stage: next === 'error' ? errorStage.value : undefined,
        error_class: next === 'error' ? nextErrorClass : undefined,
        attempt: attempt.value,
      });
    }
  }

  function trackAction(action: 'upgrade' | 'skip' | 'retry' | 'restart', trigger: 'initial' | 'error'): void {
    track('forced_upgrade_action', {
      ...properties(),
      action,
      trigger,
      attempt: attempt.value,
      waited_ms: action === 'skip' ? Math.max(0, now() - shownAt) : undefined,
      error_stage: trigger === 'error' ? errorStage.value : undefined,
    });
  }

  function fail(stage: ForcedUpgradeErrorStage, message: string, errorClass: string): void {
    errorStage.value = stage;
    errorMessage.value = message;
    transition('error', errorClass);
  }

  async function check(): Promise<void> {
    transition('checking');
    const result = await deps.check().catch((error: unknown): UpdateCheckResult => ({
      outcome: 'error',
      message: error instanceof Error ? error.message : String(error),
    }));
    if (result.outcome === 'available' && result.version !== undefined && !isForcedUpgradeRequired(result.version, minimumVersion.value)) {
      targetVersion.value = result.version;
      if (deps.status.value.state === 'downloaded') {
        transition('downloaded');
      } else {
        transition('downloading');
        deps.download();
      }
      return;
    }
    if (result.outcome === 'available' && result.version !== undefined) {
      targetVersion.value = result.version;
      fail('check', 'target_below_minimum', 'target_below_minimum');
      return;
    }
    if (result.outcome === 'error') {
      fail('check', result.message, 'check_failed');
      return;
    }
    fail('check', 'target_below_minimum', 'target_below_minimum');
  }

  async function start(): Promise<void> {
    if (!deps.supported || phase.value !== 'idle') return;
    const raw = await deps.fetchPolicy().catch(() => null);
    const minimum = desktopMinimumVersion(raw);
    if (!isForcedUpgradeRequired(deps.currentVersion, minimum)) return;
    minimumVersion.value = minimum;
    shownAt = now();
    skipAvailableAt = shownAt + 10_000;
    remainingSeconds.value = 10;
    phase.value = 'prompt';
    track('forced_upgrade_prompt_shown', properties());
    timer = setInterval(() => {
      remainingSeconds.value = Math.max(0, Math.ceil((skipAvailableAt - now()) / 1000));
      if (remainingSeconds.value === 0 && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    }, 250);
  }

  function skip(): void {
    if (remainingSeconds.value > 0 || (phase.value !== 'prompt' && phase.value !== 'error')) return;
    trackAction('skip', phase.value === 'prompt' ? 'initial' : 'error');
    transition('skipped');
  }

  async function upgrade(): Promise<void> {
    if (phase.value !== 'prompt') return;
    attempt.value = 1;
    trackAction('upgrade', 'initial');
    await check();
  }

  async function install(): Promise<void> {
    transition('installing');
    try {
      await deps.install();
      if (deps.status.value.state === 'downloaded') transition('downloaded');
    } catch (error) {
      fail('install', error instanceof Error ? error.message : String(error), 'install_failed');
    }
  }

  async function retry(): Promise<void> {
    if (phase.value !== 'error') return;
    attempt.value += 1;
    trackAction('retry', 'error');
    errorMessage.value = '';
    if (errorStage.value === 'check') {
      await check();
      return;
    }
    if (errorStage.value === 'install') {
      await install();
      return;
    }
    transition('downloading');
    deps.download();
  }

  async function restart(): Promise<void> {
    if (phase.value !== 'downloaded') return;
    trackAction('restart', attempt.value === 1 ? 'initial' : 'error');
    await install();
  }

  const stopWatching = watch(deps.status, (status) => {
    if (!visible.value || phase.value === 'prompt' || phase.value === 'installing') return;
    if (status.state === 'downloading') {
      targetVersion.value = status.version ?? targetVersion.value;
      transition('downloading');
    } else if (status.state === 'downloaded') {
      targetVersion.value = status.version ?? targetVersion.value;
      transition('downloaded');
    } else if (status.state === 'error' && phase.value !== 'error') {
      targetVersion.value = status.version ?? targetVersion.value;
      fail('download', status.message ?? 'download_failed', 'download_failed');
    }
  });

  function dispose(): void {
    if (timer !== undefined) clearInterval(timer);
    stopWatching();
  }

  return {
    phase,
    visible,
    busy,
    minimumVersion,
    targetVersion,
    errorMessage,
    errorStage,
    remainingSeconds,
    attempt,
    lastErrorClass: computed(() => lastErrorClass),
    start,
    skip,
    upgrade,
    retry,
    restart,
    dispose,
  };
}
