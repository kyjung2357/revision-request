const fs = require('node:fs/promises');
const path = require('node:path');
const { createVSIX } = require('@vscode/vsce');

function validatePngIcon(bytes, label = 'Extension icon') {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!Buffer.isBuffer(bytes) || bytes.length < 33 || !bytes.subarray(0, 8).equals(signature) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error(label + ': packaging supports PNG icons with a valid IHDR header only.');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 128 || height < 128 || width > 1024 || height > 1024) {
    throw new Error(label + ' is ' + width + 'x' + height + ' pixels. Each icon dimension must be between 128 and 1024 pixels before packaging.');
  }
  return { width, height };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const ignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  if (!ignore.split(/\r?\n/).some(line => /^\/?\.codex-\*\/?$/.test(line.trim()))) {
    throw new Error('Ignore .codex-* build directories before packaging.');
  }
  if (typeof manifest.icon !== 'string' || !manifest.icon.trim()) throw new Error('Declare a PNG icon in package.json before packaging.');
  validatePngIcon(await fs.readFile(path.join(root, manifest.icon)), manifest.icon);
  await fs.access(path.join(root, 'LICENSE'));
  const output = path.join(root, '.codex-artifacts');
  await fs.mkdir(output, { recursive: true });
  await createVSIX({ cwd: root, dependencies: false,
    packagePath: path.join(output, `${manifest.name}-${manifest.version}.vsix`) });
}
module.exports = { validatePngIcon };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
