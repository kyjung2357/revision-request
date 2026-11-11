/** The private, local bridge protocol. This is not the public MCP transport. */
export const BRIDGE_PROTOCOL = 1;
export const BRIDGE_MAX_BYTES = 32 * 1024 * 1024;
export const BRIDGE_METHODS = [
  'capabilities', 'client_status', 'read_target', 'create_request', 'list_requests',
  'get_request_status', 'open_preview', 'decide', 'undo'
] as const;
export type BridgeMethod = typeof BRIDGE_METHODS[number];
export interface McpWorkspace { uri: string; name: string }
export type McpHandler = (method: BridgeMethod, args: Record<string, unknown>, workspaceUri: string) => Promise<unknown>;
export interface BridgeManifest {
  version: 1;
  instanceId: string;
  pid: number;
  port: number;
  token: string;
  workspaces: McpWorkspace[];
}
export interface BridgeRequest {
  id: string;
  version: 1;
  instanceId: string;
  token: string;
  workspaceUri: string;
  method: BridgeMethod;
  args: Record<string, unknown>;
}
export interface BridgeResponse {
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}
export interface McpClientStatus {
  name: string;
  version?: string;
  adapterVersion: string;
  plugin?: import('./mcpCompatibility').PluginMetadata;
  stage: 'initialized' | 'tools_listed' | 'tool_called';
  lastSeenAt: string;
}
export interface McpCapabilities {
  extensionVersion?: string;
  features?: string[];
  formatGuideSha256?: string;
  lastClient?: McpClientStatus;
  allowAgentDecisions: boolean;
  workspaceUri: string;
}
export interface McpCreateArgs {
  path: string;
  expectedHash: string;
  after: string;
  clientRequestId: string;
  title?: string;
  reason?: string;
  explanations?: { line: number; text: string }[];
}
export interface McpStatus {
  requestId: string;
  requestPath: string;
  path: string;
  revision: string;
  status: 'pending' | 'completed' | 'unavailable' | 'stale';
  pending: number;
  accepted: number;
  ignored: number;
  issue?: string;
  cleanup?: 'retained' | 'deleted' | 'failed';
  completedAt?: string;
  targetHash?: string;
  hunks: { id: string; oldStart: number; newStart: number; oldLines: number; newLines: number;
    decision: 'pending' | 'accepted' | 'ignored'; explanation?: string }[];
}
export class McpBridgeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'McpBridgeError'; }
}
