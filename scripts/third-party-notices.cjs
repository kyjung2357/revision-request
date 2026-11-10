const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const portable = value => value.split(path.sep).join('/');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const licenseName = /^(?:licen[cs]e|copying)(?:[._-].*)?$/i;
const noticeName = /^notice(?:[._-].*)?$/i;

function packageRoot(root, input) {
  const absolute = path.resolve(root, input);
  const parts = absolute.split(path.sep);
  const index = parts.lastIndexOf('node_modules');
  if (index < 0) return undefined;
  const name = parts[index + 1];
  if (!name) throw new Error('Cannot identify bundled dependency: ' + input);
  const end = index + (name.startsWith('@') ? 3 : 2);
  if (parts.length < end) throw new Error('Cannot identify scoped dependency: ' + input);
  return parts.slice(0, end).join(path.sep) || path.parse(absolute).root;
}

/** Inspect emitted bytes, not every installed or merely parsed dependency. */
async function collectBundledPackages({ root, metafiles }) {
  const packages = new Map();
  for (const metafile of metafiles) {
    for (const [output, details] of Object.entries(metafile.outputs)) {
      for (const [input, contribution] of Object.entries(details.inputs ?? {})) {
        if (!(contribution.bytesInOutput > 0)) continue;
        const directory = packageRoot(root, input);
        if (!directory) continue;
        let entry = packages.get(directory);
        if (!entry) {
          entry = { directory, inputs: new Set(), bundles: new Map() };
          packages.set(directory, entry);
        }
        entry.inputs.add(portable(path.relative(root, path.resolve(root, input))));
        const bundle = portable(path.relative(root, path.resolve(root, output)));
        entry.bundles.set(bundle, (entry.bundles.get(bundle) ?? 0) + contribution.bytesInOutput);
      }
    }
  }
  const result = [];
  for (const entry of packages.values()) {
    const manifest = JSON.parse(await fs.readFile(path.join(entry.directory, 'package.json'), 'utf8'));
    if (typeof manifest.name !== 'string' || !manifest.name || typeof manifest.version !== 'string' || !manifest.version) {
      throw new Error('Bundled dependency has no exact package name/version: ' + entry.directory);
    }
    const files = (await fs.readdir(entry.directory, { withFileTypes: true }))
      .filter(file => file.isFile() && (licenseName.test(file.name) || noticeName.test(file.name)))
      .map(file => file.name).sort(compare);
    const documents = [];
    for (const name of files) {
      const bytes = await fs.readFile(path.join(entry.directory, name));
      if (!bytes.toString('utf8').trim()) throw new Error('Bundled license/notice is empty: ' + path.join(entry.directory, name));
      documents.push({ name, kind: licenseName.test(name) ? 'license' : 'notice', bytes,
        relativePath: portable(path.relative(root, path.join(entry.directory, name))) });
    }
    if (!documents.some(document => document.kind === 'license')) {
      throw new Error('Missing LICENSE/LICENCE/COPYING text for bundled dependency ' + manifest.name + '@' + manifest.version);
    }
    result.push({
      name: manifest.name,
      version: manifest.version,
      declaredLicense: typeof manifest.license === 'string' ? manifest.license : manifest.license?.type ?? null,
      packageRoot: portable(path.relative(root, entry.directory)),
      inputs: [...entry.inputs].sort(compare),
      bundles: [...entry.bundles].sort(([a], [b]) => compare(a, b)).map(([file, bytesInOutput]) => ({ file, bytesInOutput })),
      documents,
    });
  }
  result.sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version) || compare(a.packageRoot, b.packageRoot));
  return result;
}

async function writeThirdPartyNotices({ root, outDir, metafiles }) {
  const packages = await collectBundledPackages({ root, metafiles });
  const chunks = [Buffer.from(
    'THIRD-PARTY NOTICES\n\n' +
    'These dependencies contribute code to the distributed bundles.\n' +
    'Their license and notice files are reproduced below without changing the original bytes.\n' +
    'See bundled-dependencies.json for exact versions, source files, and SHA-256 hashes.\n', 'utf8')];
  for (const item of packages) {
    chunks.push(Buffer.from('\n' + '='.repeat(78) + '\n' + item.name + '@' + item.version + '\n' +
      'Package: ' + item.packageRoot + '\n' + 'Declared license: ' + (item.declaredLicense ?? '(not declared)') + '\n', 'utf8'));
    for (const document of item.documents) {
      chunks.push(Buffer.from('\n--- ' + document.relativePath + ' ---\n', 'utf8'), document.bytes);
      if (document.bytes[document.bytes.length - 1] !== 10) chunks.push(Buffer.from('\n'));
    }
  }
  const notices = Buffer.concat(chunks);
  const metadata = {
    schemaVersion: 1,
    noticesSha256: digest(notices),
    packages: packages.map(({ documents, ...item }) => ({ ...item,
      licenseFiles: documents.filter(document => document.kind === 'license').map(document => ({ path: document.relativePath, bytes: document.bytes.length, sha256: digest(document.bytes) })),
      noticeFiles: documents.filter(document => document.kind === 'notice').map(document => ({ path: document.relativePath, bytes: document.bytes.length, sha256: digest(document.bytes) })),
    })),
  };
  await fs.mkdir(outDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(outDir, 'THIRD_PARTY_NOTICES.txt'), notices),
    fs.writeFile(path.join(outDir, 'bundled-dependencies.json'), JSON.stringify(metadata, null, 2) + '\n', 'utf8'),
  ]);
  console.log('Third-party notices: ' + packages.length + ' bundled packages.');
  return metadata;
}

module.exports = { collectBundledPackages, writeThirdPartyNotices };
