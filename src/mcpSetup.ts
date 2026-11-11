import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface McpInstallation { adapterPath: string; registryDir: string }
export async function installMcpAdapter(extensionRoot: string, globalStoragePath: string): Promise<McpInstallation> {
  const folder = path.join(globalStoragePath, 'mcp');
  await fs.mkdir(folder, {recursive: true, mode: 0o700});
  const adapterPath = path.join(folder, 'rr-mcp.cjs');
  const manifest = JSON.parse(await fs.readFile(path.join(extensionRoot, 'package.json'), 'utf8')) as {main: string};
  const bundle = await fs.readFile(path.join(extensionRoot, path.dirname(manifest.main), 'mcp-server.cjs'));
  let identical = false;
  try { identical = bundle.equals(await fs.readFile(adapterPath)); } catch { /* First installation. */ }
  if (!identical) {
    const temporary = adapterPath + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, bundle, {flag: 'wx', mode: 0o600});
      await fs.rename(temporary, adapterPath);
    } finally { await fs.rm(temporary, {force: true}).catch(() => undefined); }
  }
  return {adapterPath, registryDir: path.join(folder, 'instances')};
}

export function createMcpConfiguration(options: McpInstallation & {
  runtime: string; workspaceUri: string; instanceId?: string;
}) {
  const args = [options.adapterPath, '--registry-dir', options.registryDir, '--workspace', options.workspaceUri];
  if (options.instanceId) args.push('--instance-id', options.instanceId);
  const entry = {command: options.runtime, args, env: {ELECTRON_RUN_AS_NODE: '1'}};
  const json = {mcpServers: {revision_request: entry}};
  const codexToml = '[mcp_servers.revision_request]\n' +
    'command = ' + JSON.stringify(entry.command) + '\n' +
    'args = ' + JSON.stringify(entry.args) + '\n' +
    'env = { ELECTRON_RUN_AS_NODE = "1" }\n';
  return {json, codexToml};
}
