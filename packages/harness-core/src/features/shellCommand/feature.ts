import { createFeature, useAgent, type Feature } from '@moonshot-ai/agent-core/app/index';
import {
  createFacadeToken,
  useCleanup,
  useExpose,
  useFire,
  type RuntimeEvent,
} from '@moonshot-ai/agent-core/kernel/index';

import type { OsHost } from '#/features/os/host/index';

import { openShellCommands } from './runner';

export interface RunShellCommandInput {
  readonly command: string;
  readonly commandId?: string;
}

export interface RunShellCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly isError: boolean;
  readonly backgrounded?: boolean;
}

export interface ShellCommandFace {
  run(input: RunShellCommandInput): Promise<RunShellCommandResult>;
  cancel(commandId: string): void;
}

export const ShellCommandRef = createFacadeToken<ShellCommandFace>('shellCommand');

export interface ShellStartedEvent extends RuntimeEvent {
  readonly type: 'shell.started';
  readonly agentId: string;
  readonly commandId: string;
}

export interface ShellOutputEvent extends RuntimeEvent {
  readonly type: 'shell.output';
  readonly agentId: string;
  readonly commandId: string;
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

export interface ShellCompletedEvent extends RuntimeEvent {
  readonly type: 'shell.completed';
  readonly agentId: string;
  readonly commandId: string;
  readonly isError: boolean;
}

export type ShellCommandEvent = ShellStartedEvent | ShellOutputEvent | ShellCompletedEvent;

export interface CreateShellCommandProps {
  readonly workDir: string;
  readonly shell?: string;
  readonly timeoutMs?: number;
  readonly host?: OsHost;
}

export const SHELL_COMMAND_DEFAULT_TIMEOUT_MS = 120_000;

export function createShellCommand(
  props: CreateShellCommandProps,
): Feature<void, ShellCommandEvent> {
  return createFeature<ShellCommandEvent>('shellCommand', {
    agent() {
      const host = props.host;
      if (host === undefined) return;
      const commands = openShellCommands({
        workDir: props.workDir,
        shell: props.shell ?? '/bin/bash',
        timeoutMs: props.timeoutMs ?? SHELL_COMMAND_DEFAULT_TIMEOUT_MS,
        agent: useAgent(),
        fire: useFire(),
        host,
      });
      useExpose(ShellCommandRef, commands.face);
      useCleanup(() => commands.stop());
    },
  });
}
