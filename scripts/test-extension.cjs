const fs = require('node:fs/promises');
const path = require('node:path');
const { build } = require('esbuild');
const { buildAll } = require('./build.cjs');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '..');
  const scratch = path.join(root, '.codex-test');
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const workspace = path.join(scratch, (process.env.RR_PREVIEW === '1' ? 'rr-visual-preview-' : 'workspace-') + runId);
  const profile = path.join(scratch, 'profile-' + runId);
  const extensions = path.join(scratch, 'extensions');
  const report = path.join(scratch, 'results-' + runId + '.json');
  const testBundle = path.join(scratch, 'extension.test.cjs');
  const executable = process.env.VSCODE_EXECUTABLE ||
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe');
  await fs.access(executable);
  await fs.mkdir(path.join(workspace, '.vscode'), { recursive: true });
  await fs.mkdir(profile, { recursive: true });
  await fs.mkdir(extensions, { recursive: true });
  await fs.writeFile(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off',
    'workbench.startupEditor': 'none',
    'window.restoreWindows': 'none',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'files.autoSave': 'off',
    'revisionRequest.previewOnOpen': false,
    'revisionRequest.autoDeleteCompleted': false,
    'files.trimTrailingWhitespace': false,
    'files.insertFinalNewline': false,
    'files.trimFinalNewlines': false,
    'editor.formatOnSave': false,
  }, null, 2));
  await buildAll();
  await build({
    entryPoints: [path.join(root, 'test', 'extension.test.ts')],
    outfile: testBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    logLevel: 'info',
  });

  console.log('Running real VS Code Extension Host tests.');
  console.log('Fixture workspace: ' + workspace);
  console.log('Results: ' + report);
  const exitCode = await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: process.env.RR_TEST_EXTENSION || root,
    extensionTestsPath: testBundle,
    extensionTestsEnv: { RR_TEST_REPORT: report, RR_PREVIEW: process.env.RR_PREVIEW },
    launchArgs: [
      workspace,
      '--new-window',
      '--user-data-dir=' + profile,
      '--extensions-dir=' + extensions,
      '--disable-workspace-trust',
      '--disable-extensions',
      '--skip-welcome',
      '--skip-release-notes',
    ],
  });
  const result = JSON.parse(await fs.readFile(report, 'utf8'));
  if (exitCode !== 0 || result.failed !== 0 || result.passed < 30) {
    throw new Error('The host did not report a complete passing integration run.');
  }
  await fs.writeFile(path.join(scratch, 'latest-results.json'), JSON.stringify({
    ...result, report, workspace,
  }, null, 2));
  console.log('Real Extension Host: ' + result.passed + '/' + result.tests.length + ' tests passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
