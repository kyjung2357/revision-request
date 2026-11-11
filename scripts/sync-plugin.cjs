"use strict";
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const repositoryRoot = path.resolve(__dirname, '..');
const normalize = text => text.replace(/\r\n?/g, '\n');

/** Regenerate portable plugin release metadata and references from owning sources. */
async function syncPlugin({root = repositoryRoot, check = false} = {}) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error('The extension needs a valid release version before synchronizing the plugin.');
  }
  const guide = normalize(await fs.readFile(path.join(root, 'docs/FORMAT.md'), 'utf8'));
  const schema = normalize(await fs.readFile(path.join(root, 'schemas/revision-request.schema.json'), 'utf8'));
  JSON.parse(schema);
  const compatibility = JSON.parse(await fs.readFile(path.join(root, 'compatibility.json'), 'utf8'));
  if (!Array.isArray(compatibility.features) || !compatibility.features.length ||
      !compatibility.features.every(value => typeof value === 'string' && value.length > 0 && value.length <= 128) ||
      new Set(compatibility.features).size !== compatibility.features.length) {
    throw new Error('compatibility.json must declare unique, nonempty feature names.');
  }
  const updates = new Map();
  for (const relative of ['plugin/plugin.json', 'plugin/.codex-plugin/plugin.json']) {
    const value = JSON.parse(await fs.readFile(path.join(root, relative), 'utf8'));
    if (value.name !== manifest.name) throw new Error('Preserve the extension and plugin identity when synchronizing releases.');
    value.version = manifest.version;
    updates.set(relative, JSON.stringify(value, null, 2) + '\n');
  }
  updates.set('plugin/skills/revision-request/references/format.md', guide);
  updates.set('plugin/skills/revision-request/references/schema.json', schema);
  updates.set('plugin/compatibility.json', JSON.stringify({
    features: compatibility.features,
    formatGuideSha256: createHash('sha256').update(guide, 'utf8').digest('hex'),
    extensionVersion: manifest.version,
  }, null, 2) + '\n');
  const changed = [];
  for (const [relative, content] of updates) {
    let existing;
    try { existing = normalize(await fs.readFile(path.join(root, relative), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing !== content) changed.push(relative);
  }
  if (check && changed.length) {
    throw new Error('Plugin release files are out of sync: ' + changed.join(', ') + '. Run npm run sync:plugin.');
  }
  if (!check) {
    for (const relative of changed) {
      await fs.mkdir(path.dirname(path.join(root, relative)), {recursive: true});
      await fs.writeFile(path.join(root, relative), updates.get(relative), 'utf8');
    }
  }
  return {version: manifest.version, changed};
}
module.exports = {syncPlugin};
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--check') || args.length > 1) {
    console.error('Usage: node scripts/sync-plugin.cjs [--check]');
    process.exitCode = 1;
  } else void syncPlugin({check: args.includes('--check')}).then(result => {
    console.log(`Plugin ${result.version}: ${result.changed.length ? 'synchronized ' + result.changed.length + ' release files' : 'release files are synchronized'}.`);
  }).catch(error => {console.error(error.message); process.exitCode = 1;});
}
