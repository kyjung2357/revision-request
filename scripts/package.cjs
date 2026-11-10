const fs = require('node:fs/promises');
const path = require('node:path');
const { createVSIX } = require('@vscode/vsce');

async function main() {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const ignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  if (!ignore.split(/\r?\n/).some(line => /^\/?\.codex-\*\/?$/.test(line.trim()))) {
    throw new Error('Ignore .codex-* build directories before packaging.');
  }
  await fs.access(path.join(root, 'LICENSE'));
  const output = path.join(root, '.codex-artifacts');
  await fs.mkdir(output, { recursive: true });
  await createVSIX({ cwd: root, dependencies: false,
    packagePath: path.join(output, `${manifest.name}-${manifest.version}.vsix`) });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
