import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanForDebuggerLiterals } from '../../src/core/debuggerLiteralScanner';

let workspaceDir: string;

async function writeWorkspaceFile(relativePath: string, content: string): Promise<void> {
  const filePath = join(workspaceDir, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'cds-debug-scanner-'));
});

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

describe('scanForDebuggerLiterals', () => {
  it('finds debugger statements in JavaScript and TypeScript sources', async () => {
    await writeWorkspaceFile('srv/sample-service.js', [
      'module.exports = () => {',
      '  debugger;',
      '};',
    ].join('\n'));
    await writeWorkspaceFile('app/sample-controller.ts', [
      'export function run(): void {',
      '  const value = 1;',
      '  debugger; // remove before deploy',
      '}',
    ].join('\n'));

    await expect(scanForDebuggerLiterals(workspaceDir)).resolves.toEqual([
      {
        filePath: join(workspaceDir, 'app/sample-controller.ts'),
        line: 3,
        preview: 'debugger; // remove before deploy',
      },
      {
        filePath: join(workspaceDir, 'srv/sample-service.js'),
        line: 2,
        preview: 'debugger;',
      },
    ]);
  });

  it('skips generated and dependency folders', async () => {
    await writeWorkspaceFile('node_modules/pkg/index.js', 'debugger;\n');
    await writeWorkspaceFile('dist/index.js', 'debugger;\n');
    await writeWorkspaceFile('build/index.js', 'debugger;\n');
    await writeWorkspaceFile('coverage/report.js', 'debugger;\n');
    await writeWorkspaceFile('.git/hooks/pre-commit.js', 'debugger;\n');
    await writeWorkspaceFile('srv/live.js', 'debugger;\n');

    const matches = await scanForDebuggerLiterals(workspaceDir);

    expect(matches.map((match) => match.filePath)).toEqual([
      join(workspaceDir, 'srv/live.js'),
    ]);
  });

  it('ignores line comments and block comments', async () => {
    await writeWorkspaceFile('srv/commented.js', [
      '// debugger;',
      '/*',
      ' debugger;',
      '*/',
      'const sample = "debugger;";',
      'debugger;',
      '/* debugger; */',
    ].join('\n'));

    const matches = await scanForDebuggerLiterals(workspaceDir);

    expect(matches).toEqual([
      {
        filePath: join(workspaceDir, 'srv/commented.js'),
        line: 6,
        preview: 'debugger;',
      },
    ]);
  });

  it('still reports test files because committed debugger statements are risky when copied into runtime code', async () => {
    await writeWorkspaceFile('test/sample.test.ts', 'debugger;\n');

    await expect(scanForDebuggerLiterals(workspaceDir)).resolves.toEqual([
      {
        filePath: join(workspaceDir, 'test/sample.test.ts'),
        line: 1,
        preview: 'debugger;',
      },
    ]);
  });

  it('honors the maxFilesScanned cap', async () => {
    await writeWorkspaceFile('srv/a.js', 'const a = 1;\n');
    await writeWorkspaceFile('srv/b.js', 'debugger;\n');

    const matches = await scanForDebuggerLiterals(workspaceDir, { maxFilesScanned: 1 });

    expect(matches).toEqual([]);
  });

  it('returns an empty result for missing folders', async () => {
    await expect(scanForDebuggerLiterals(join(workspaceDir, 'missing'))).resolves.toEqual([]);
  });
});
