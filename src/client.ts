import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { TransportConfig, ToolInfo } from './types.js';

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

/**
 * Connect to an MCP server, list its tools, then disconnect.
 */
export async function discoverTools(config: TransportConfig): Promise<ToolInfo[]> {
  const client = new Client({ name: 'mcpx', version: '0.1.0' });
  const transport = createTransport(config);

  try {
    await client.connect(transport);
    const result = await client.listTools();

    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
    }));
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
  const client = new Client({ name: 'mcpx', version: '0.1.0' });
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
