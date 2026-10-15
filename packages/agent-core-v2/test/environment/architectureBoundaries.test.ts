import { readFileSync } from 'node:fs';
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

describe('environment architecture boundaries', () => {
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

  it('routes terminal, MCP, and external FS through explicit environment selection', () => {
    const terminal = source('session/terminal/terminalService.ts');
    const mcp = source('workspace/workspaceMcp/workspaceMcpService.ts');
    const externalFs = kapSource('routes/fs.ts');

    expect(terminal).toContain('this.environmentResolver.acquire(');
    expect(terminal).toContain('new EnvironmentWorkspaceView(');
    expect(terminal).not.toMatch(/@IHostTerminalService/);
    expect(mcp).toContain('environmentResolver: this.environmentResolver');
    expect(mcp).not.toMatch(/@IHost(?:FileSystem|FsWatchService|ProcessService|TerminalService)/);
    expect(externalFs).toContain('createEnvironmentFs(');
    expect(externalFs).not.toContain('environmentWorkspaceId');
  });
});
