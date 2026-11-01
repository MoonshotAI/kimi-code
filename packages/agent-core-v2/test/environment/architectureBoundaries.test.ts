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
    expect(program).not.toContain('IHostProcessService');
    expect(dependencies).not.toContain('IInstantiationService');
    expect(workspaceInstance).not.toContain('createChild(');
    expect(workspaceSources).not.toMatch(/registerScopedService\(\s*['"]program['"]/);
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
      if (path !== 'agent/tools/os/read/readTool.ts') {
        expect(contents).not.toMatch(/@IHost(?:Environment|FileSystem|FsWatchService|ProcessService|TerminalService)/);
      }
    }
    const readTool = source('agent/tools/os/read/readTool.ts');
    expect(readTool).toContain('this.localOutputTarget(args.path)');
    expect(readTool).toContain('isTaskOutputFilePath(normalized, environmentPath.join(this.session.sessionDir');
    expect(readTool).toContain('this.resultTruncation.isSpillFilePath(normalized)');
    expect(readTool).not.toContain('IAgentEnvironmentService | IHostFileSystem');
    expect(readTool).not.toContain("'acquire' in environment");
  });

  it('routes MCP and external FS through explicit environment selection', () => {
    const mcp = source('workspace/workspaceMcp/workspaceMcpService.ts');
    const externalFs = kapSource('routes/fs.ts');

    expect(mcp).toContain('environmentResolver: this.environmentResolver');
    expect(mcp).not.toMatch(/@IHost(?:FileSystem|FsWatchService|ProcessService|TerminalService)/);
    expect(externalFs).toContain('session.accessor.get(ISessionWorkdir)');
    expect(externalFs).toContain('.get(IEnvironmentService).acquire(');
    expect(externalFs).not.toContain('environmentWorkspaceId');
  });
});
