import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { BridgeClient } from './mcpBridge';
import { compatibilityWarnings } from './mcpCompatibility';

export interface McpDiagnosticCheck {
  stage: string;
  status: 'ok' | 'warning' | 'blocked' | 'unknown';
  summary: string;
  nextStep?: string;
}
export interface McpDiagnosticOptions {
  extensionVersion: string;
  workspace?: {name: string; uri: string};
  trusted: boolean;
  adapterPath: string;
  bundledAdapterPath: string;
  registryDir: string;
  bridgeInstanceId?: string;
  bridgeStarting?: boolean;
  bridgeStartFailed?: boolean;
}
export interface McpDiagnosticReport {
  generatedAt: string;
  extensionVersion: string;
  workspaceName?: string;
  workspaceUri?: string;
  checks: McpDiagnosticCheck[];
}
const text = (value: unknown, maximum = 120): string | undefined => typeof value === 'string' && value.length <= maximum
  && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
const version = (value: unknown): string | undefined => {
  const result = text(value);
  return result && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(result) ? result : undefined;
};
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const features = (value: unknown): string[] | undefined => Array.isArray(value) && value.length <= 64
  && value.every(item => typeof item === 'string' && /^[a-z0-9_.-]{1,100}$/i.test(item)) ? value : undefined;
const hash = (value: unknown): string | undefined => typeof value === 'string' && /^[a-f\d]{64}$/i.test(value) ? value : undefined;
const reload = 'Run Developer: Reload Window with this local workspace trusted, then restart the MCP connection in your agent.';
async function adapterHash(filename: string): Promise<string | undefined> {
  const info = await fs.stat(filename);
  if (!info.isFile() || info.size > 32 * 1024 * 1024) return undefined;
  return createHash('sha256').update(await fs.readFile(filename)).digest('hex');
}

/** Read-only diagnostics. Never return bridge discovery records, credentials, or raw exceptions. */
export async function collectMcpDiagnostics(
  options: McpDiagnosticOptions,
  probe: () => Promise<unknown> = () => new BridgeClient({registryDir: options.registryDir,
    workspaceUri: options.workspace!.uri, instanceId: options.bridgeInstanceId}).call('capabilities'),
): Promise<McpDiagnosticReport> {
  const report: McpDiagnosticReport = {generatedAt: new Date().toISOString(), extensionVersion: options.extensionVersion,
    workspaceName: options.workspace?.name, workspaceUri: options.workspace?.uri, checks: []};
  const add = (stage: string, status: McpDiagnosticCheck['status'], summary: string, nextStep?: string) =>
    report.checks.push({stage, status, summary, ...(nextStep ? {nextStep} : {})});
  if (!options.workspace) add('Workspace', 'blocked', 'No local workspace folder selected.', 'Open the local project folder in VS Code and run this command again.');
  else if (!options.trusted) add('Workspace', 'blocked', 'This workspace is not trusted.', 'Review this workspace and grant Workspace Trust if you trust its contents, then run diagnostics again.');
  else add('Workspace', 'ok', 'A trusted local workspace is selected.');

  const [installed, bundled] = await Promise.allSettled([adapterHash(options.adapterPath), adapterHash(options.bundledAdapterPath)]);
  if (bundled.status !== 'fulfilled' || !bundled.value) {
    add('Adapter', 'blocked', 'The extension adapter bundle is missing or unreadable.', 'Reinstall Revision Request, then reload this VS Code window.');
  } else if (installed.status !== 'fulfilled' || !installed.value) {
    add('Adapter', 'blocked', 'The stable local MCP adapter is missing or unreadable.', reload);
  } else if (installed.value !== bundled.value) {
    add('Adapter', 'warning', 'The installed MCP adapter differs from this extension bundle.', reload);
  } else add('Adapter', 'ok', 'The stable MCP adapter matches this extension bundle.');

  let capabilities: Record<string, unknown> | undefined;
  if (!options.workspace || !options.trusted) add('Bridge', 'blocked', 'The bridge requires a trusted local workspace.');
  else if (!options.bridgeInstanceId) {
    if (options.bridgeStarting) add('Bridge', 'unknown', 'The bridge is still starting.', 'Wait a moment and run diagnostics again.');
    else add('Bridge', 'blocked', options.bridgeStartFailed ? 'The local bridge failed to start.' : 'The local bridge is not running in this window.', reload);
  } else {
    try {
      capabilities = record(await probe());
      if (!capabilities || capabilities.workspaceUri !== options.workspace.uri || typeof capabilities.allowAgentDecisions !== 'boolean') {
        capabilities = undefined;
        add('Bridge', 'blocked', 'The authenticated bridge returned an unexpected capability response.', reload);
      } else add('Bridge', 'ok', 'This window answered an authenticated request for the selected workspace.');
    } catch (error) {
      const code = record(error)?.code;
      const ambiguous = code === 'AMBIGUOUS_WORKSPACE';
      add('Bridge', 'blocked', ambiguous ? 'Multiple live windows match this workspace.' : 'The local bridge did not answer the authenticated probe.',
        ambiguous ? 'Close the duplicate workspace window or use an explicitly pinned instance, then reconnect the agent.' : reload);
    }
  }

  if (capabilities) {
    const remote = {version: version(capabilities.extensionVersion), features: features(capabilities.features), formatGuideSha256: hash(capabilities.formatGuideSha256)};
    const warnings = compatibilityWarnings(remote);
    add('Format', warnings.length ? 'warning' : 'ok', warnings.length ? warnings.join(' ') : 'The bridge and bundled format instructions agree.',
      warnings.length ? 'Update Revision Request and the agent plugin together, then reconnect and call rr_get_format before creating a proposal.' : undefined);
    if (remote.version) add('Bridge version', 'ok', remote.version);
    add('Supported features', remote.features ? 'ok' : 'unknown', remote.features?.join(', ') || 'The bridge did not report its supported format features.');
    add('Agent decisions', 'ok', capabilities.allowAgentDecisions ? 'Enabled in User settings.' : 'Disabled in User settings (default).');
  } else add('Format', 'unknown', 'Bridge compatibility could not be checked.');

  const client = record(capabilities?.lastClient);
  const plugin = record(client?.plugin);
  if (client) {
    const name = text(client.name) ?? 'Unnamed client';
    const clientVersion = version(client.version);
    const adapterVersion = version(client.adapterVersion);
    add('Agent client', 'ok', `Last observed: ${name}${clientVersion ? ' ' + clientVersion : ''}; adapter ${adapterVersion ?? 'version unknown'}.`);
    if (adapterVersion && adapterVersion !== options.extensionVersion) add('Adapter version', 'warning', 'The running client adapter version differs from this extension.', 'Restart the MCP connection so the agent launches the updated adapter.');
    if (plugin) {
      const remote = {version: version(plugin.version), features: features(plugin.features), formatGuideSha256: hash(plugin.formatGuideSha256)};
      const warnings = compatibilityWarnings(remote);
      add('Agent plugin', warnings.length ? 'warning' : 'ok', `Last reported version: ${remote.version ?? 'unknown'}. ${warnings.join(' ')}`.trim(),
        warnings.length ? 'Update or reinstall the agent plugin from the matching release and reconnect it. Do not edit the plugin cache by hand.' : undefined);
    } else add('Agent plugin', 'unknown', 'The last client did not report plugin metadata. It may be a direct MCP connection or an older plugin.', 'If using the plugin, update it and reconnect. Direct MCP connections do not require the plugin.');
    const observed = text(client.lastSeenAt, 40);
    const event = client.stage === 'tools_listed' ? 'tools/list' : client.stage === 'tool_called' ? 'a tool call' : 'initialization';
    add('Agent tool discovery', 'unknown', `Last observed ${event}${observed ? ' at ' + observed : ''}. Current tool exposure in the agent is not observable from VS Code.`,
      'In the agent, verify that rr_get_format and rr_read_target are listed and call rr_get_format. If absent, reload the plugin or restart the MCP connection.');
  } else {
    add('Agent client', 'unknown', 'No client handshake has been observed by this VS Code window.');
    add('Agent plugin', 'unknown', 'Plugin version is unknown until the plugin connects and reports its metadata.');
    add('Agent tool discovery', 'unknown', 'A running bridge does not prove that the agent has loaded rr_* tools.',
      'Run Revision Request: Copy MCP Configuration, configure or repair the agent connection, and reconnect. Then verify rr_get_format is listed in the agent.');
  }
  return report;
}

export function formatMcpDiagnostics(report: McpDiagnosticReport): string {
  const lines = ['Revision Request MCP connection diagnostics', `Checked: ${report.generatedAt}`,
    `Extension: ${report.extensionVersion}`, `Workspace: ${report.workspaceName ?? '(none)'}`,
    `Workspace URI: ${report.workspaceUri ?? '(none)'}`, '',
    ...report.checks.flatMap(check => [`[${check.status.toUpperCase()}] ${check.stage}: ${check.summary}`, ...(check.nextStep ? ['  Next: ' + check.nextStep] : [])]), '',
    'This report is read-only. It does not change MCP configuration, files, or review decisions.'];
  return lines.join('\n');
}
