"use strict";
const fs = require('node:fs/promises');
const {createWriteStream} = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {pipeline} = require('node:stream/promises');
const {ZipFile} = require('yazl');
const {syncPlugin} = require('./sync-plugin.cjs');
const root = path.resolve(__dirname, '..');
async function packagePlugin() {
  const ignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  if (!/(^|\n)\.codex-\*\//.test(ignore)) throw new Error('Ignore .codex-* artifacts before packaging.');
  await syncPlugin({root});
  const source = path.join(root, 'plugin');
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'plugin.json'), 'utf8'));
  const version = require('../package.json').version;
  if (manifest.name !== 'revision-request' || manifest.version !== version) throw new Error('Keep the plugin and extension release versions in sync.');
  const files = [];
  async function visit(relative) {
    const absolute = path.join(source, relative);
    const info = await fs.lstat(absolute);
    if (info.isSymbolicLink()) throw new Error('Do not package symlinks: ' + relative);
    if (info.isDirectory()) {
      for (const name of (await fs.readdir(absolute)).sort()) await visit(path.posix.join(relative, name));
    } else if (info.isFile()) files.push(relative);
    else throw new Error('Only regular plugin files can be packaged: ' + relative);
  }
  for (const name of ['plugin.json', 'compatibility.json', 'mcp.json', '.codex-plugin', '.mcp.json', 'skills', 'scripts', 'assets', 'README.md', 'LICENSE']) await visit(name);
  const directory = path.join(root, '.codex-artifacts');
  await fs.mkdir(directory, {recursive: true});
  const output = path.join(directory, `revision-request-plugin-${version}.zip`);
  const temporary = output + '.' + randomUUID() + '.tmp';
  const zip = new ZipFile();
  const written = pipeline(zip.outputStream, createWriteStream(temporary, {flags: 'wx'}));
  try {
    for (const relative of files) zip.addBuffer(await fs.readFile(path.join(source, relative)), relative);
    zip.end();
    await written;
    await fs.rename(temporary, output);
  } catch (error) {
    zip.outputStream.destroy();
    await written.catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
  console.log(`Packaged ${files.length} plugin files: ${output}`);
  return output;
}
module.exports = {packagePlugin};
if (require.main === module) void packagePlugin().catch(error => {console.error(error.message); process.exitCode = 1;});
