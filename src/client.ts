import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { TransportConfig, ToolInfo, ServerMeta } from './types.js';

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
 * Create the appropriate MCP transport from a config object.
 */
export function createTransport(config: TransportConfig): Transport {
  switch (config.type) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env ? { ...process.env as Record<string, string>, ...config.env } : undefined,
        stderr: 'pipe',
      });

    case 'http':
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        config.headers
          ? { requestInit: { headers: config.headers } }
          : undefined,
      );

    case 'sse':
      return new SSEClientTransport(
        new URL(config.url),
        config.headers
          ? { requestInit: { headers: config.headers } }
          : undefined,
      );
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
export async function discoverTools(config: TransportConfig): Promise<DiscoveryResult> {
  const client = new Client({ name: 'mcpkit', version: __PKG_VERSION__ });
  const transport = createTransport(config);

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
 * Connect to an MCP server, invoke a tool, extract the text result, then disconnect.
 */
export async function callTool(
  config: TransportConfig,
  toolName: string,
  params: Record<string, unknown>,
): Promise<string> {
  const client = new Client({ name: 'mcpkit', version: __PKG_VERSION__ });
  const transport = createTransport(config);

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: toolName, arguments: params });

    // Extract text from content array — only "content" style results have it
    if ('content' in result && Array.isArray(result.content)) {
      return result.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
    }

    // Fallback for toolResult-style responses
    if ('toolResult' in result) {
      return String(result.toolResult);
    }

    return '';
  } finally {
    await transport.close();
  }
}
