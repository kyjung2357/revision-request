const fs = require('node:fs/promises');
const path = require('node:path');
const { createVSIX } = require('@vscode/vsce');
const { execFileSync } = require('node:child_process');
const { buildAll } = require('./build.cjs');
const { packagePlugin } = require('./package-plugin.cjs');

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
  // Keep local build artifacts ignored; give the distributed extension normal paths.
  const compiler = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
  execFileSync(process.execPath, [compiler, '--noEmit'], {cwd: root, stdio: 'inherit'});
  await buildAll();
  const stagingRoot = path.join(root, '.codex-package');
  await fs.mkdir(stagingRoot, {recursive: true});
  const stage = await fs.mkdtemp(path.join(stagingRoot, 'extension-'));
  await fs.mkdir(path.join(stage, 'dist'));
  for (const name of ['README.md', 'LICENSE', '.vscodeignore', 'language-configuration.json', 'media', 'docs', 'schemas', 'syntaxes']) {
    await fs.cp(path.join(root, name), path.join(stage, name), {recursive: true});
  }
  // Keep the README GIF for both GitHub and the Marketplace.
  await fs.access(path.join(stage, 'media', 'intro.gif'));
  for (const name of ['extension.js', 'mcp-server.cjs', 'review-highlight.js']) {
    await fs.copyFile(path.join(root, '.codex-build', name), path.join(stage, 'dist', name));
  }
  await fs.copyFile(path.join(root, '.codex-build', 'THIRD_PARTY_NOTICES.txt'), path.join(stage, 'THIRD_PARTY_NOTICES.txt'));
  const metadata = JSON.parse(await fs.readFile(path.join(root, '.codex-build', 'bundled-dependencies.json'), 'utf8'));
  for (const dependency of metadata.packages) {
    for (const bundle of dependency.bundles) {
      bundle.file = 'dist/' + path.posix.basename(bundle.file);
    }
  }
  await fs.writeFile(path.join(stage, 'bundled-dependencies.json'), JSON.stringify(metadata, null, 2) + '\n');
  const releaseManifest = {...manifest, main: './dist/extension.js'};
  delete releaseManifest.scripts;
  delete releaseManifest.devDependencies;
  await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify(releaseManifest, null, 2) + '\n');
  const output = path.join(root, '.codex-artifacts');
  await fs.mkdir(output, { recursive: true });
  console.log('Release staging: ' + stage);
  await createVSIX({ cwd: stage, dependencies: false,
    packagePath: path.join(output, `${manifest.name}-${manifest.version}.vsix`) });
  await packagePlugin();
}
module.exports = { validatePngIcon };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
