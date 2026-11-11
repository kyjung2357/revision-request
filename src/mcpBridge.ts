import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  BRIDGE_MAX_BYTES, BRIDGE_METHODS, BRIDGE_PROTOCOL, McpBridgeError,
  type BridgeManifest, type BridgeMethod, type BridgeRequest, type BridgeResponse,
  type McpHandler, type McpWorkspace
} from './mcpTypes';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function sameSecret(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function errorResult(error: unknown): {code: string; message: string} {
  return {code: error instanceof McpBridgeError ? error.code : 'REQUEST_FAILED',
    message: error instanceof Error ? error.message : 'The request failed.'};
}
function receiveFrame(socket: net.Socket, callback: (frame: Buffer) => void, reject: (error: Error) => void) {
  let chunks: Buffer[] = [], length = 0, done = false;
  const data = (chunk: Buffer) => {
    if (done) return;
    length += chunk.length;
    if (length > BRIDGE_MAX_BYTES) {
      done = true; chunks = []; socket.removeListener('data', data);
      reject(new McpBridgeError('MESSAGE_TOO_LARGE', 'The local MCP message exceeds its size limit.')); return;
    }
    const end = chunk.indexOf(10);
    if (end === -1) { chunks.push(chunk); return; }
    done = true;
    socket.removeListener('data', data);
    if (chunk.subarray(end + 1).toString('utf8').trim()) {
      chunks = []; reject(new McpBridgeError('INVALID_MESSAGE', 'Send one message per local connection.')); return;
    }
    chunks.push(chunk.subarray(0, end));
    const frame = Buffer.concat(chunks);
    chunks = [];
    callback(frame);
  };
  socket.on('data', data);
  socket.once('end', () => { if (!done) { done = true; reject(new McpBridgeError('CONNECTION_CLOSED', 'The local bridge closed before responding.')); } });
}

export interface McpBridge {
  instanceId: string;
  registryDir: string;
  publish(): Promise<void>;
  dispose(): void;
}

/** Local authenticated dispatcher; it exposes only the fixed method allowlist. */
export async function startMcpBridge(options: {
  registryDir: string; workspaces: () => McpWorkspace[]; handler: McpHandler;
}): Promise<McpBridge> {
  const instanceId = randomUUID(), token = randomBytes(32).toString('base64url');
  const registryDir = path.resolve(options.registryDir);
  await fs.mkdir(registryDir, {recursive: true, mode: 0o700});
  const manifestPath = path.join(registryDir, instanceId + '.json');
  const sockets = new Set<net.Socket>();
  let disposed = false, port = 0, publications: Promise<void> = Promise.resolve();
  const server = net.createServer(socket => {
    if (sockets.size >= 32 || disposed) { socket.destroy(); return; }
    sockets.add(socket);
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    const reply = (response: BridgeResponse) => {
      if (socket.destroyed) return;
      const text = JSON.stringify(response) + '\n';
      if (Buffer.byteLength(text) > BRIDGE_MAX_BYTES) {
        socket.end(JSON.stringify({id: response.id, error: {code: 'MESSAGE_TOO_LARGE', message: 'The local response exceeds its size limit.'}}) + '\n');
      } else socket.end(text);
    };
    receiveFrame(socket, frame => {
      void (async () => {
        let id = '';
        try {
          const request: unknown = JSON.parse(frame.toString('utf8'));
          if (!record(request)) throw new McpBridgeError('INVALID_MESSAGE', 'Invalid local request.');
          if (typeof request.id === 'string' && request.id.length <= 128) id = request.id;
          if (!sameSecret(request.token, token) || request.instanceId !== instanceId) {
            throw new McpBridgeError('UNAUTHORIZED', 'The local MCP connection is not authorized.');
          }
          if (!id || request.version !== BRIDGE_PROTOCOL || !record(request.args) ||
              !BRIDGE_METHODS.includes(request.method as BridgeMethod)) {
            throw new McpBridgeError('INVALID_MESSAGE', 'Unsupported local MCP request.');
          }
          if (typeof request.workspaceUri !== 'string' ||
              !options.workspaces().some(workspace => workspace.uri === request.workspaceUri)) {
            throw new McpBridgeError('WORKSPACE_UNAVAILABLE', 'Open the configured local workspace in a trusted VS Code window.');
          }
          const result = await options.handler(request.method as BridgeMethod, request.args, request.workspaceUri);
          reply({id, result});
        } catch (error) { reply({id, error: errorResult(error)}); }
      })();
    }, error => reply({id: '', error: errorResult(error)}));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  server.on('error', () => { /* Client receives a connection error; do not leak credentials into logs. */ });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Could not start the local bridge.'); }
  port = address.port;
  const publish = () => {
    publications = publications.catch(() => undefined).then(async () => {
      if (disposed) return;
      const manifest: BridgeManifest = {version: 1, instanceId, pid: process.pid, port, token, workspaces: options.workspaces()};
      const temporary = manifestPath + '.' + randomUUID() + '.tmp';
      try {
        await fs.writeFile(temporary, JSON.stringify(manifest), {encoding: 'utf8', flag: 'wx', mode: 0o600});
        if (!disposed) await fs.rename(temporary, manifestPath);
      } finally { await fs.rm(temporary, {force: true}).catch(() => undefined); }
    });
    return publications;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const socket of sockets) socket.destroy();
    server.close();
    void publications.catch(() => undefined).then(() => fs.rm(manifestPath, {force: true}).catch(() => undefined));
  };
  try { await publish(); } catch (error) { dispose(); throw error; }
  return {instanceId, registryDir, publish, dispose};
}

function validManifest(value: unknown): value is BridgeManifest {
  if (!record(value) || value.version !== 1 || typeof value.instanceId !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(value.instanceId) || !Number.isInteger(value.pid) || (value.pid as number) <= 0 ||
      !Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535 ||
      typeof value.token !== 'string' || value.token.length < 32 || value.token.length > 128 ||
      !Array.isArray(value.workspaces) || value.workspaces.length > 128) return false;
  return value.workspaces.every(item => record(item) && typeof item.uri === 'string' &&
    item.uri.startsWith('file:') && typeof item.name === 'string');
}

export function callBridge(
  manifest: BridgeManifest, workspaceUri: string, method: BridgeMethod, args: Record<string, unknown> = {}, timeoutMs = 30_000
): Promise<unknown> {
  if (!validManifest(manifest)) return Promise.reject(new McpBridgeError('INVALID_INSTANCE', 'Invalid local bridge instance.'));
  const id = randomUUID();
  const request: BridgeRequest = {id, version: 1, instanceId: manifest.instanceId, token: manifest.token, workspaceUri, method, args};
  const serialized = JSON.stringify(request) + '\n';
  if (Buffer.byteLength(serialized) > BRIDGE_MAX_BYTES) return Promise.reject(new McpBridgeError('MESSAGE_TOO_LARGE', 'The local request exceeds its size limit.'));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({host: '127.0.0.1', port: manifest.port});
    let finished = false;
    const finish = (error?: Error, result?: unknown) => {
      if (finished) return;
      finished = true; socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(new McpBridgeError('BRIDGE_TIMEOUT', 'VS Code did not respond to the local MCP request.')));
    socket.once('error', () => finish(new McpBridgeError('CONNECTION_FAILED', 'The VS Code window is not reachable. Reopen the configured workspace.')));
    socket.once('connect', () => socket.write(serialized));
    receiveFrame(socket, frame => {
      try {
        const response: unknown = JSON.parse(frame.toString('utf8'));
        if (!record(response) || response.id !== id) throw new McpBridgeError('INVALID_RESPONSE', 'Invalid response from the local bridge.');
        if (record(response.error)) throw new McpBridgeError(String(response.error.code || 'REQUEST_FAILED'), String(response.error.message || 'The request failed.'));
        finish(undefined, response.result);
      } catch (error) { finish(error instanceof Error ? error : new Error('Invalid bridge response.')); }
    }, error => finish(error));
  });
}

/** Resolve the explicitly configured workspace, never the focused/latest window. */
export class BridgeClient {
  constructor(readonly options: {registryDir: string; workspaceUri: string; instanceId?: string}) {}
  private async candidates(): Promise<BridgeManifest[]> {
    let names: string[];
    try { names = await fs.readdir(this.options.registryDir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const results: BridgeManifest[] = [];
    for (const name of names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).slice(0, 128)) {
      try {
        const filename = path.join(this.options.registryDir, name);
        if ((await fs.stat(filename)).size > 64 * 1024) continue;
        const candidate: unknown = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (validManifest(candidate) && candidate.workspaces.some(workspace => workspace.uri === this.options.workspaceUri) &&
            (!this.options.instanceId || candidate.instanceId === this.options.instanceId)) results.push(candidate);
      } catch { /* Ignore incomplete, stale, or unrelated discovery records. */ }
    }
    return results;
  }
  async call(method: BridgeMethod, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    const candidates = await this.candidates();
    const probes = await Promise.all(candidates.map(async manifest => {
      try {
        const capabilities = await callBridge(manifest, this.options.workspaceUri, 'capabilities', {}, Math.min(2500, timeoutMs));
        return {manifest, capabilities};
      } catch { return undefined; }
    }));
    const live = probes.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    if (!live.length) throw new McpBridgeError('WORKSPACE_UNAVAILABLE', 'Open the configured local workspace in VS Code with Revision Request enabled and trusted.');
    if (live.length !== 1) throw new McpBridgeError('AMBIGUOUS_WORKSPACE', 'This workspace is open in multiple VS Code windows. Close the duplicate window or configure --instance-id explicitly.');
    if (method === 'capabilities') return live[0].capabilities;
    return callBridge(live[0].manifest, this.options.workspaceUri, method, args, timeoutMs);
  }
}
