const path = require('node:path');
const fs = require('node:fs/promises');
const { build } = require('esbuild');
const { syncPlugin } = require('./sync-plugin.cjs');
const { writeThirdPartyNotices } = require('./third-party-notices.cjs');

async function buildAll() {
  const root = path.resolve(__dirname, '..');
  await syncPlugin({root});
  const common = { absWorkingDir: root, bundle: true, platform: 'node', format: 'cjs', logLevel: 'info', metafile: true };
  const results = await Promise.all([
    build({ ...common, entryPoints: [path.join(root, 'src/extension.ts')],
      outfile: path.join(root, '.codex-build/extension.js'), external: ['vscode'] }),
    build({ ...common, entryPoints: [path.join(root, 'src/mcpServer.ts')],
      outfile: path.join(root, '.codex-build/mcp-server.cjs'), loader: { '.md': 'text' } }),
    build({ ...common, entryPoints: [path.join(root, 'src/pdfReviewWorker.ts')],
      outfile: path.join(root, '.codex-build/pdf-review-worker.cjs') }),
    build({ ...common, platform: 'browser', format: 'iife', globalName: 'RRHighlight',
      entryPoints: [path.join(root, 'src/reviewHighlight.ts')],
      outfile: path.join(root, '.codex-build/review-highlight.js') }),
  ]);
  // Ship the maintained PDF.js renderer locally; the webview never downloads code.
  const pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const pdfOut = path.join(root, '.codex-build', 'pdfjs');
  await fs.mkdir(pdfOut, {recursive:true});
  const assets = [['legacy/build/pdf.min.mjs','pdf.mjs'], ['legacy/build/pdf.worker.min.mjs','pdf.worker.mjs'],
    ['LICENSE','LICENSE'], ['cmaps','cmaps'], ['standard_fonts','standard_fonts'], ['wasm','wasm']];
  const staticOutputs = {};
  async function copyAsset(source, target) {
    const stat = await fs.stat(source);
    if (stat.isDirectory()) {
      await fs.mkdir(target,{recursive:true});
      for (const name of await fs.readdir(source)) await copyAsset(path.join(source,name),path.join(target,name));
    } else {
      await fs.copyFile(source,target);
      staticOutputs[path.relative(root,target)] = {inputs:{[path.relative(root,source)]:{bytesInOutput:stat.size}}};
    }
  }
  for (const [source,target] of assets) await copyAsset(path.join(pdfRoot,source),path.join(pdfOut,target));
  await writeThirdPartyNotices({ root, outDir: path.join(root, '.codex-build'),
    metafiles: [...results.map(result => result.metafile), {outputs:staticOutputs}] });
}
module.exports = { buildAll };
if (require.main === module) buildAll().catch(error => { console.error(error); process.exitCode = 1; });
