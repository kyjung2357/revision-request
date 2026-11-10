const path = require('node:path');
const { build } = require('esbuild');
const { writeThirdPartyNotices } = require('./third-party-notices.cjs');

async function buildAll() {
  const root = path.resolve(__dirname, '..');
  const common = { absWorkingDir: root, bundle: true, platform: 'node', format: 'cjs', logLevel: 'info', metafile: true };
  const results = await Promise.all([
    build({ ...common, entryPoints: [path.join(root, 'src/extension.ts')],
      outfile: path.join(root, '.codex-build/extension.js'), external: ['vscode'] }),
    build({ ...common, entryPoints: [path.join(root, 'src/mcpServer.ts')],
      outfile: path.join(root, '.codex-build/mcp-server.cjs'), loader: { '.md': 'text' } }),
  ]);
  await writeThirdPartyNotices({ root, outDir: path.join(root, '.codex-build'), metafiles: results.map(result => result.metafile) });
}
module.exports = { buildAll };
if (require.main === module) buildAll().catch(error => { console.error(error); process.exitCode = 1; });
