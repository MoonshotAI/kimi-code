import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerMigrateCommand } from '#/migration/command';

describe('registerMigrateCommand', () => {
  it('adds a migrate subcommand with --run and --config-only options', () => {
    const program = new Command('kimi');
    registerMigrateCommand(program, () => {});
    const sub = program.commands.find((c) => c.name() === 'migrate');
    expect(sub).toBeDefined();
    expect(sub!.description()).toContain('Migrate');
    const flags = sub!.options.map((o) => o.long);
    expect(flags).toEqual(['--run', '--config-only']);
  });

  it('invokes the host handler with both flags false by default', () => {
    const program = new Command('kimi');
    const onMigrate = vi.fn();
    registerMigrateCommand(program, onMigrate);
    program.parse(['migrate'], { from: 'user' });
    expect(onMigrate).toHaveBeenCalledWith({ run: false, configOnly: false });
  });

  it('parses --run and --config-only', () => {
    const program = new Command('kimi');
    const onMigrate = vi.fn();
    registerMigrateCommand(program, onMigrate);
    program.parse(['migrate', '--run', '--config-only'], { from: 'user' });
    expect(onMigrate).toHaveBeenCalledWith({ run: true, configOnly: true });
  });

  it('is not shadowed by a same-named parent option', () => {
    const program = new Command('kimi');
    program.option('--yes', 'legacy alias', false);
    program.option('-y, --yolo', 'yolo', false);
    const onMigrate = vi.fn();
    registerMigrateCommand(program, onMigrate);
    program.parse(['migrate', '--run'], { from: 'user' });
    expect(onMigrate).toHaveBeenCalledWith({ run: true, configOnly: false });
  });
});
