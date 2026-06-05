import type { HeadlessCommand } from './commands';

export async function runHeadless(command: HeadlessCommand, version: string): Promise<void> {
  void command;
  void version;
  throw new Error('headless mode is not implemented yet');
}
