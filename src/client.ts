import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { TransportConfig, ToolInfo, ServerMeta } from './types.js';

/**
 * Replace $prev.field references in params with values from the previous tool result.
 * E.g. { "user_id": "$prev.userId" } with prevResult { userId: "abc" } → { "user_id": "abc" }
 */
function substituteRefs(
  params: Record<string, unknown>,
  prev: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.startsWith('$prev.')) {
      const field = value.slice('$prev.'.length);
      result[key] = prev[field] ?? value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Auto-detect transport type from a user-provided input string.
 *
 * - URLs ending with `/sse` → SSE transport
 * - Other URLs → Streamable HTTP transport
 * - Everything else → stdio (command + args)
 */
export function parseServerInput(input: string): TransportConfig {
  const trimmed = input.trim();

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    if (trimmed.endsWith('/sse')) {
      return { type: 'sse', url: trimmed };
    }
    return { type: 'http', url: trimmed };
  }

  const parts = trimmed.split(/\s+/);
  return {
    type: 'stdio',
    command: parts[0],
    args: parts.slice(1),
  };
}

/**
 * Resolve ${VAR_NAME} references in a string with values from process.env.
 * Throws if a referenced variable is not set.
 */
export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName) => {
    const resolved = process.env[varName];
    if (resolved === undefined) {
      throw new Error(`Environment variable "${varName}" is not set`);
    }
    return resolved;
  });
}

/**
 * Resolve env var references in all header values.
 */
export function resolveHeaders(headers: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = resolveEnvVars(value);
  }
  return resolved;
}

/**
 * Resolve env var references in all env values (for stdio transports).
 */
function resolveEnvValues(env: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    resolved[key] = resolveEnvVars(value);
  }
  return resolved;
}

/**
 * Create the appropriate MCP transport from a config object.
 */
export function createTransport(config: TransportConfig, authProvider?: OAuthClientProvider): Transport {
  switch (config.type) {
    case 'stdio': {
      const env = config.env ? resolveEnvValues(config.env) : undefined;
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: env ? { ...process.env as Record<string, string>, ...env } : undefined,
        stderr: 'pipe',
      });
    }

    case 'http': {
      const headers = config.headers ? resolveHeaders(config.headers) : undefined;
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          ...(headers ? { requestInit: { headers } } : {}),
          ...(authProvider ? { authProvider } : {}),
        },
      );
    }

    case 'sse': {
      const headers = config.headers ? resolveHeaders(config.headers) : undefined;
      return new SSEClientTransport(
        new URL(config.url),
        {
          ...(headers ? { requestInit: { headers } } : {}),
          ...(authProvider ? { authProvider } : {}),
        },
      );
    }
  }
}

export interface DiscoveryResult {
  tools: ToolInfo[];
  serverMeta: ServerMeta;
}

/**
 * Extract npm package name from a stdio transport config.
 * Handles: npx @scope/pkg, npx -y @scope/pkg, npx pkg@latest, etc.
 */
function extractNpmPackage(config: TransportConfig): string | undefined {
  if (config.type !== 'stdio') return undefined;
  const allArgs = [config.command, ...config.args];
  if (!allArgs.includes('npx')) return undefined;

  for (const arg of config.args) {
    if (arg.startsWith('-')) continue;
    // Strip version suffix: @browsermcp/mcp@latest → @browsermcp/mcp
    return arg.replace(/@[^/]+$/, '');
  }
  return undefined;
}

/**
 * Extract PyPI package name from a stdio transport config.
 * Handles: uvx pkg, uv run pkg, python -m pkg, etc.
 */
function extractPypiPackage(config: TransportConfig): string | undefined {
  if (config.type !== 'stdio') return undefined;
  const allArgs = [config.command, ...config.args];

  // uvx mcp-server-git  OR  uvx --from mcp-server-fetch mcp-server-fetch
  if (allArgs.includes('uvx')) {
    const fromIdx = config.args.indexOf('--from');
    if (fromIdx !== -1 && fromIdx + 1 < config.args.length) {
      // --from specifies the actual package name
      return config.args[fromIdx + 1].replace(/\[.*\]$/, '');
    }
    for (const arg of config.args) {
      if (arg.startsWith('-')) continue;
      return arg.replace(/\[.*\]$/, '');
    }
    return undefined;
  }

  // uv run mcp-server-git  OR  uv run --with pkg ...
  if (config.command === 'uv' && config.args[0] === 'run') {
    const withIdx = config.args.indexOf('--with');
    if (withIdx !== -1 && withIdx + 1 < config.args.length) {
      return config.args[withIdx + 1].replace(/\[.*\]$/, '');
    }
    for (const arg of config.args.slice(1)) {
      if (arg.startsWith('-')) continue;
      return arg.replace(/\[.*\]$/, '');
    }
    return undefined;
  }

  // python -m mcp_server_git → PyPI name uses hyphens
  if ((config.command === 'python' || config.command === 'python3') && config.args.includes('-m')) {
    const mIdx = config.args.indexOf('-m');
    if (mIdx + 1 < config.args.length) {
      return config.args[mIdx + 1].replace(/_/g, '-');
    }
  }

  return undefined;
}

/**
 * Fetch package description from npm registry.
 */
async function fetchNpmDescription(packageName: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${packageName}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    const data = await res.json() as Record<string, unknown>;
    return (data.description as string) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch package description from PyPI registry.
 */
async function fetchPypiDescription(packageName: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://pypi.org/pypi/${packageName}/json`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    const data = await res.json() as Record<string, unknown>;
    const info = data.info as Record<string, unknown> | undefined;
    return (info?.summary as string) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Connect to an MCP server, list its tools, then disconnect.
 */
export async function discoverTools(config: TransportConfig, authProvider?: OAuthClientProvider): Promise<DiscoveryResult> {
  const client = new Client({ name: 'mcpkit', version: __PKG_VERSION__ });
  const transport = createTransport(config, authProvider);

  try {
    await client.connect(transport);

    const serverVersion = client.getServerVersion();
    const serverMeta: ServerMeta = {
      name: serverVersion?.name,
      version: serverVersion?.version,
      instructions: (client as any)._instructions ?? undefined,
    };

    // Try to fetch package description from registries
    const npmPkg = extractNpmPackage(config);
    if (npmPkg) {
      serverMeta.packageDescription = await fetchNpmDescription(npmPkg);
    } else {
      const pypiPkg = extractPypiPackage(config);
      if (pypiPkg) {
        serverMeta.packageDescription = await fetchPypiDescription(pypiPkg);
      }
    }

    const result = await client.listTools();
    const tools = result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
    }));

    return { tools, serverMeta };
  } finally {
    await transport.close();
  }
}

/**
 * Extract a text string from an MCP tool result.
 * Priority: text content parts → structuredContent → toolResult → non-text content → empty.
 */
function extractResultText(result: Record<string, unknown>): string {
  // Text content parts
  if ('content' in result && Array.isArray(result.content)) {
    const texts = (result.content as Array<{ type: string; text?: string }>)
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text);
    if (texts.length > 0) return texts.join('\n');
  }

  // Structured content (JSON responses)
  if ('structuredContent' in result && result.structuredContent != null) {
    return JSON.stringify(result.structuredContent, null, 2);
  }

  // toolResult-style responses
  if ('toolResult' in result) {
    return String(result.toolResult);
  }

  // Last resort: serialize non-text content (images, resources, etc.)
  if ('content' in result && Array.isArray(result.content) && result.content.length > 0) {
    return JSON.stringify(result.content, null, 2);
  }

  return '';
}

/**
 * Connect to an MCP server, invoke a tool, extract the text result, then disconnect.
 */
export async function callTool(
  config: TransportConfig,
  toolName: string,
  params: Record<string, unknown>,
  authProvider?: OAuthClientProvider,
): Promise<string> {
  const client = new Client({ name: 'mcpkit', version: __PKG_VERSION__ });
  const transport = createTransport(config, authProvider);

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: toolName, arguments: params });
    return extractResultText(result as Record<string, unknown>);
  } finally {
    await transport.close();
  }
}

/**
 * Connect once, invoke multiple tools sequentially in the same session, then disconnect.
 * Supports $prev.field substitution: params referencing "$prev.fieldName" are replaced
 * with the corresponding field from the previous tool's parsed JSON output.
 * Returns an array of text results, one per call.
 */
export async function callToolsChained(
  config: TransportConfig,
  calls: Array<{ toolName: string; params: Record<string, unknown> }>,
  authProvider?: OAuthClientProvider,
): Promise<string[]> {
  const client = new Client({ name: 'mcpkit', version: __PKG_VERSION__ });
  const transport = createTransport(config, authProvider);

  try {
    await client.connect(transport);
    const results: string[] = [];
    let prevResult: Record<string, unknown> = {};

    for (const { toolName, params } of calls) {
      const resolvedParams = substituteRefs(params, prevResult);
      const result = await client.callTool({ name: toolName, arguments: resolvedParams });
      const text = extractResultText(result as Record<string, unknown>);

      // Parse result as JSON for $prev substitution in subsequent calls
      try {
        prevResult = JSON.parse(text);
      } catch {
        prevResult = { _text: text };
      }

      results.push(text);
    }

    return results;
  } finally {
    await transport.close();
  }
}
