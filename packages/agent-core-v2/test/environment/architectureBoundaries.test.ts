import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const sourceRoot = join(import.meta.dirname, '../../src');
const kapSourceRoot = join(import.meta.dirname, '../../../kap-server/src');

function source(path: string): string {
  return readFileSync(join(sourceRoot, path), 'utf8');
}

function kapSource(path: string): string {
  return readFileSync(join(kapSourceRoot, path), 'utf8');
}

function sourceFiles(path: string): string[] {
  const root = join(sourceRoot, path);
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name.endsWith('.ts')) result.push(absolute);
    }
  };
  visit(root);
  return result;
}

describe('environment architecture boundaries', () => {
  it('keeps Program out of the scoped service registry', () => {
    const workspaceInstance = source('workspace/workspaceInstance/workspaceInstance.ts');
    const program = source('program/program.ts');
    const dependencies = source('program/programDependencies.ts');
    const workspaceSources = sourceFiles('workspace').map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(workspaceInstance).not.toContain('createScopedChildHandle');
    expect(program).not.toContain('ServicesAccessor');
    expect(program).not.toContain('readonly accessor');
    expect(program).not.toContain('PROGRAM_SERVICE_KIND');
    expect(program).not.toContain('ServiceCollection');
    expect(program).not.toContain('createChild(');
    expect(program).not.toContain('SyncDescriptor');
    expect(program).not.toContain('invokeFunction');
    expect(program).not.toContain('ServiceIdentifier');
    expect(program).not.toContain('IHostEnvironment');
    expect(program).not.toContain('IHostFileSystem');
    expect(program).not.toContain('IHostProcessService');
    expect(program).not.toContain('IHostTerminalService');
    expect(dependencies).not.toContain('IInstantiationService');
    expect(workspaceInstance).not.toContain('createChild(');
    expect(workspaceSources).not.toMatch(/registerScopedService\(\s*['"]program['"]/);
  });

  it('attaches environment providers through context and the provider host', () => {
    const provider = source('environment/environmentProvider.ts');
    const local = source('environment/localEnvironment.ts');
    const workspaceInstance = source('workspace/workspaceInstance/workspaceInstance.ts');
    const manager = source('workspace/workspaceInstance/workspaceInstanceManagerService.ts');
    expect(provider).toContain('EnvironmentProviderContext');
    expect(provider).toContain('registerEnvironment');
    expect(provider).not.toContain('WorkspaceInstance');
    expect(provider).not.toContain('EnvironmentProviderRegistry');
    expect(provider).not.toContain('readonly environments');
    expect(local).not.toContain('ServicesAccessor');
    expect(workspaceInstance).not.toContain('IInstantiationService');
    expect(manager).toContain('provider.attach(');
    expect(manager).toContain('this.providerHost(instance, handles)');
  });

  it('builds every agent OS execution from an environment lease and workspace view', () => {
    for (const path of [
      'agent/tools/os/bash/bashTool.ts',
      'agent/tools/os/glob/globTool.ts',
      'agent/tools/os/grep/grepTool.ts',
      'agent/tools/os/read/readTool.ts',
      'agent/tools/os/write/writeTool.ts',
      'agent/tools/edit/editTool.ts',
      'agent/tools/read-media-file/readMediaFileTool.ts',
    ]) {
      const contents = source(path);
      expect(contents).toContain('new EnvironmentWorkspaceView(');
      expect(contents).toMatch(/acquireOrWhenReady\(this\.environment|\.environment\.(acquire|acquireWhenReady|inspect)\(/);
      expect(contents).not.toMatch(/@IHost(?:Environment|FileSystem|FsWatchService|ProcessService|TerminalService)/);
    }
    const readTool = source('agent/tools/os/read/readTool.ts');
    expect(readTool).not.toContain('IAgentEnvironmentService | IHostFileSystem');
    expect(readTool).not.toContain("'acquire' in environment");
  });

  it('routes terminal, MCP, and external FS through explicit environment selection', () => {
    const terminal = source('session/terminal/terminalService.ts');
    const mcp = source('workspace/workspaceMcp/workspaceMcpService.ts');
    const externalFs = kapSource('routes/fs.ts');

    expect(terminal).toContain('this.environmentResolver.acquire(');
    expect(terminal).toContain('new EnvironmentWorkspaceView(');
    expect(terminal).not.toMatch(/@IHostTerminalService/);
    expect(mcp).toContain('environmentResolver: this.environmentResolver');
    expect(mcp).not.toMatch(/@IHost(?:FileSystem|FsWatchService|ProcessService|TerminalService)/);
    expect(externalFs).toContain('get(IEnvironmentResolver).acquire(');
    expect(externalFs).toContain('new LocalEnvironment(');
  });
});
