import { McpServerConfigSchema, type McpServerConfig, type McpTool } from '../../protocol/src/index';
import type { Redactor } from './redaction';

/** Runtime-only retained configuration; public status omits argument/environment values. */
export interface StoredMcpServer extends McpServerConfig {
  tools: McpTool[]; toolsListedAt: string | null; serverInfo: { name: string; version: string } | null;
  lastError: string | null; running: boolean;
}
const forbidden = /(?:credential|secret|token|password|passwd|authorization|api[_-]?key|cookie|proxy|node_options|bearer|private)|(?:^|_)(?:auth|key|keys|pass|pat|pwd|session|signing)(?:_|$)/i;
const reserved = /^(?:path|comspec|systemroot|windir|pathext|psmodulepath|temp|tmp|userprofile)$/i;

export function checkMcpConfig(value: unknown, redactor: Redactor): McpServerConfig {
  const config = McpServerConfigSchema.parse(value);
  const fields: [string, string][] = [['name', config.name], ['command', config.command], ['cwd', config.cwd],
    ...config.arguments.map((item, i): [string, string] => [`argument ${i + 1}`, item]),
    ...Object.entries(config.environment).map(([key, item]): [string, string] => [`environment ${key}`, item])];
  for (const key of Object.keys(config.environment)) {
    if (forbidden.test(key) || reserved.test(key)) throw new Error('An environment variable name is not permitted for MCP servers.');
  }
  for (const [field, content] of fields) {
    if (content.includes('\0') || redactor.text(content) !== content) throw new Error(`MCP ${field} contains invalid or secret-like content and cannot be stored.`);
  }
  return config;
}

export function sanitizeStoredMcp(server: StoredMcpServer, redactor: Redactor): StoredMcpServer {
  const config = storedMcpConfiguration(server);
  try { checkMcpConfig(config, redactor); return server; }
  catch {
    return { ...server, name: redactor.text(server.name), command: redactor.text(server.command), cwd: '',
      arguments: [], environment: {}, enabled: false, tools: [], readOnlyTools: [], serverInfo: null, running: false,
      lastError: 'Configuration quarantined: unsafe stored values were removed. Review and save a new configuration. Historical backups may retain old values.' };
  }
}

export function storedMcpConfiguration(server: StoredMcpServer): McpServerConfig {
  return { id: server.id, key: server.key, name: server.name, command: server.command, arguments: server.arguments,
    cwd: server.cwd, environment: server.environment, enabled: server.enabled, readOnlyTools: server.readOnlyTools, callTimeoutMs: server.callTimeoutMs };
}
