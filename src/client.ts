import { execFile } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { describeOmittedParts, normalizeToolResult } from './tool-result.js';
import type { TransportConfig, ToolInfo, ToolAnnotations, ServerMeta, ParamProviderConfig } from './types.js';

/**
 * Per-call MCP request timeout, in milliseconds. The MCP SDK defaults to 60s
 * (DEFAULT_REQUEST_TIMEOUT_MSEC), which is far too short for long-running
 * tools (e.g. Databricks SQL that compiles + warms a warehouse). We bump the
 * default to 15 minutes and let users override via env var.
 */
const DEFAULT_CALL_TIMEOUT_MS = 900_000;

function resolveCallTimeoutMs(): number {
  const raw = process.env.MCPKIT_CALL_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_CALL_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CALL_TIMEOUT_MS;
  return parsed;
}

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

// --- Param provider: run a command and merge its JSON output into tool params ---

const paramProviderCache = new Map<string, { data: Record<string, unknown>; expiresAt: number }>();

function cacheKey(config: ParamProviderConfig): string {
  return `${config.command} ${(config.args ?? []).join(' ')}`;
}

/** The command line and output of a failing provider go to this process's stderr only under MCPKIT_DEBUG=1. */
function debugParamProvider(config: ParamProviderConfig, what: string, output: string): void {
  if (process.env.MCPKIT_DEBUG !== '1') return;
  const commandLine = [config.command, ...(config.args ?? [])].join(' ');
  process.stderr.write(`mcpkit [debug] param provider "${commandLine}" ${what}: ${output.slice(0, 2000)}\n`);
}

/**
 * Execute a paramProvider command and return its parsed JSON output.
 * Results are cached by TTL if configured.
 */
export async function runParamProvider(config: ParamProviderConfig): Promise<Record<string, unknown>> {
  const key = cacheKey(config);
  const cached = paramProviderCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  const parts = config.args
    ? [config.command, ...config.args]
    : config.command.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        // The provider's output and command line can hold credentials, and this message
        // reaches scripts and agents: it carries only sizes and the exit status.
        const failure = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        const status = failure.killed === true ? `killed by ${failure.signal ?? 'a signal'}` : `exit code ${failure.code ?? 'unknown'}`;
        debugParamProvider(config, `failed (${status})`, `${stderr}${stdout}`);
        reject(new Error(`the param provider failed (${status}, ${Buffer.byteLength(stderr) + Buffer.byteLength(stdout)} bytes of output)`));
      } else {
        resolve(stdout.trim());
      }
    });
  });

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(stdout);
  } catch {
    debugParamProvider(config, 'returned non-JSON output', stdout);
    throw new Error(`the param provider returned non-JSON output (${Buffer.byteLength(stdout)} bytes)`);
  }

  if (config.ttl && config.ttl > 0) {
    paramProviderCache.set(key, { data, expiresAt: Date.now() + config.ttl * 1000 });
  }

  return data;
}

/**
 * Merge paramProvider output into params. User-supplied params take precedence.
 */
function mergeParams(
  userParams: Record<string, unknown>,
  providerParams: Record<string, unknown>,
): Record<string, unknown> {
  return { ...providerParams, ...userParams };
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
 * Throws if a referenced variable is not set. If `hints` contains an entry for
 * the missing variable, its value is appended to the error as a "Hint:" recipe
 * so callers (e.g. AI agents) can learn how to mint it.
 */
export function resolveEnvVars(value: string, hints?: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName) => {
    const resolved = process.env[varName];
    if (resolved === undefined) {
      let message = `Environment variable "${varName}" is not set. Set it with 'export ${varName}=<value>' or 'mcpkit edit <server> --env ${varName}=<value>'.`;
      const hint = hints?.[varName];
      if (hint) {
        message += `\n\nHint: ${hint}`;
      }
      throw new Error(message);
    }
    return resolved;
  });
}

/**
 * Resolve env var references in all header values.
 */
export function resolveHeaders(
  headers: Record<string, string>,
  hints?: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = resolveEnvVars(value, hints);
  }
  return resolved;
}

/**
 * Resolve env var references in all env values (for stdio transports).
 */
function resolveEnvValues(
  env: Record<string, string>,
  hints?: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    resolved[key] = resolveEnvVars(value, hints);
  }
  return resolved;
}

/**
 * A fetch wrapper that preserves the HTTP method on 301/302 redirects.
 *
 * By default, `fetch()` converts POST to GET when following 301/302 redirects
 * (per HTTP spec ambiguity). Some MCP servers use 302 redirects for
 * load-balancing to shard URLs, causing the redirected GET to fail with 405.
 *
 * This wrapper uses `redirect: 'manual'` and re-sends with the original method.
 * 307/308 are also handled explicitly for completeness.
 */
export async function redirectSafeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const maxRedirects = 5;
  let currentUrl: string | URL = url;
  let remaining = maxRedirects;

  while (remaining-- > 0) {
    const response = await fetch(currentUrl, { ...init, redirect: 'manual' });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return response;
      currentUrl = new URL(location, typeof currentUrl === 'string' ? currentUrl : currentUrl.toString());
      continue;
    }

    return response;
  }

  throw new Error(`Too many redirects (max ${maxRedirects}). Check that the server URL is correct.`);
}

/**
 * Create the appropriate MCP transport from a config object.
 */
export function createTransport(
  config: TransportConfig,
  authProvider?: OAuthClientProvider,
  envHints?: Record<string, string>,
): Transport {
  switch (config.type) {
    case 'stdio': {
      const env = config.env ? resolveEnvValues(config.env, envHints) : {};
      // Always pass an explicit env. Leaving it undefined makes the MCP SDK fall
      // back to its DEFAULT_INHERITED_ENV_VARS allowlist (HOME, LOGNAME, PATH,
      // SHELL, TERM, USER), which silently drops LANG, TMPDIR, proxy settings and
      // everything else, and only for servers that happen to have no env block.
      // Servers that spawn their own subprocesses (browsers, compilers) then break
      // in ways that look unrelated to configuration.
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...process.env as Record<string, string>, ...env },
        stderr: 'pipe',
      });
    }

    case 'http': {
      const headers = config.headers ? resolveHeaders(config.headers, envHints) : undefined;
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          ...(headers ? { requestInit: { headers } } : {}),
          ...(authProvider ? { authProvider } : {}),
          fetch: redirectSafeFetch,
        },
      );
    }

    case 'sse': {
      const headers = config.headers ? resolveHeaders(config.headers, envHints) : undefined;
      return new SSEClientTransport(
        new URL(config.url),
        {
          ...(headers ? { requestInit: { headers } } : {}),
          ...(authProvider ? { authProvider } : {}),
          fetch: redirectSafeFetch,
        },
      );
    }
  }
}

export interface DiscoveryResult {
  tools: ToolInfo[];
  serverMeta: ServerMeta;
}

export interface ToolCall {
  toolName: string;
  params: Record<string, unknown>;
}

/** One finished tool call. */
export interface ToolCallOutput {
  /** What `call` prints by default: the text parts, else structured content. Never an image, audio or resource. */
  text: string;
  /** The normalised result (see `normalizeToolResult`): what `call --json` prints. */
  value: unknown;
  /** The server flagged the call as failed (`isError: true`). */
  isError: boolean;
  /**
   * What `text` leaves out: one description per kind of image, audio or resource part in the result
   * (see `describeOmittedParts`). Absent when nothing is left out. A persistent runtime sends the
   * same list over its socket, so it is also set on the daemon path.
   */
  omitted?: string[];
}

export interface ConnectedToolSession {
  client: Client;
  transport: Transport;
  close(): Promise<void>;
  callTool(toolName: string, params: Record<string, unknown>): Promise<ToolCallOutput>;
  /** Runs the calls in order and stops after the first one that reports `isError`, which is then the last output. */
  callToolsChained(calls: ToolCall[]): Promise<ToolCallOutput[]>;
}

export interface ConnectToolSessionOptions {
  /** Per-call MCP request timeout in ms. Defaults to MCPKIT_CALL_TIMEOUT_MS, else 15 minutes. */
  timeoutMs?: number;
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
 * Upper bound on `tools/list` pages followed in one discovery. A server that
 * keeps returning fresh cursors forever must not hang `install`/`update`.
 */
const MAX_TOOL_LIST_PAGES = 100;

const BOOLEAN_ANNOTATION_HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

/** Copy only the known annotation fields, with the types the protocol defines. */
function mapAnnotations(raw: unknown): ToolAnnotations | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const annotations: ToolAnnotations = {};
  if (typeof source.title === 'string') annotations.title = source.title;
  for (const key of BOOLEAN_ANNOTATION_HINTS) {
    const value = source[key];
    if (typeof value === 'boolean') annotations[key] = value;
  }
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

function toToolInfo(tool: Tool): ToolInfo {
  const annotations = mapAnnotations(tool.annotations);
  return {
    name: tool.name,
    ...(typeof tool.title === 'string' ? { title: tool.title } : {}),
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(annotations ? { annotations } : {}),
  };
}

/**
 * Follow `nextCursor` until the server has no more pages. Stops early on a
 * repeated cursor (a server that loops) and after MAX_TOOL_LIST_PAGES pages;
 * tools are de-duplicated by name, first occurrence wins.
 */
async function listAllTools(client: Client): Promise<ToolInfo[]> {
  const tools: ToolInfo[] = [];
  const seenNames = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
    const result = await client.listTools(cursor === undefined ? undefined : { cursor });
    for (const tool of result.tools) {
      if (seenNames.has(tool.name)) continue;
      seenNames.add(tool.name);
      tools.push(toToolInfo(tool));
    }

    cursor = result.nextCursor;
    if (!cursor || seenCursors.has(cursor)) break;
    seenCursors.add(cursor);
  }

  return tools;
}

/**
 * Connect to an MCP server, list its tools, then disconnect.
 */
export async function discoverTools(
  config: TransportConfig,
  authProvider?: OAuthClientProvider,
  envHints?: Record<string, string>,
): Promise<DiscoveryResult> {
  const client = new Client({ name: 'mcpkit', version: __PKG_VERSION__ });
  const transport = createTransport(config, authProvider, envHints);

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

    const tools = await listAllTools(client);

    return { tools, serverMeta };
  } finally {
    await transport.close();
  }
}

/**
 * The text `call` prints for an MCP tool result.
 * Priority: text content parts, structuredContent, toolResult, empty. Image, audio and
 * resource parts are never printed (a screenshot would be a megabyte of base64);
 * `toToolCallOutput` lists them in `omitted` instead.
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

  return '';
}

function toToolCallOutput(result: Record<string, unknown>): ToolCallOutput {
  const normalized = normalizeToolResult(result);
  const legacyToolResult = 'toolResult' in result
    && !Array.isArray(result.content)
    && result.structuredContent == null;
  const omitted = describeOmittedParts(result.content);
  return {
    text: extractResultText(result),
    value: legacyToolResult ? result.toolResult : normalized.value,
    isError: normalized.isError,
    ...(omitted.length > 0 ? { omitted } : {}),
  };
}

/**
 * Connect once and return a reusable MCP tool session.
 */
export async function connectToolSession(
  config: TransportConfig,
  authProvider?: OAuthClientProvider,
  paramProvider?: ParamProviderConfig,
  envHints?: Record<string, string>,
  options: ConnectToolSessionOptions = {},
): Promise<ConnectedToolSession> {
  const client = new Client({ name: 'mcpkit', version: __PKG_VERSION__ });
  const transport = createTransport(config, authProvider, envHints);
  let closePromise: Promise<void> | undefined;

  const close = (): Promise<void> => {
    closePromise ??= transport.close();
    return closePromise;
  };

  const callTimeoutMs = options.timeoutMs ?? resolveCallTimeoutMs();

  const callSingleTool = async (toolName: string, params: Record<string, unknown>): Promise<ToolCallOutput> => {
    const injectedParams = paramProvider ? await runParamProvider(paramProvider) : {};
    const finalParams = paramProvider ? mergeParams(params, injectedParams) : params;
    const result = await client.callTool(
      { name: toolName, arguments: finalParams },
      undefined,
      { timeout: callTimeoutMs },
    );
    return toToolCallOutput(result as Record<string, unknown>);
  };

  try {
    await client.connect(transport);
  } catch (error) {
    await close();
    throw error;
  }

  return {
    client,
    transport,
    close,
    callTool: callSingleTool,
    async callToolsChained(calls: ToolCall[]): Promise<ToolCallOutput[]> {
      const injectedParams = paramProvider ? await runParamProvider(paramProvider) : {};
      const outputs: ToolCallOutput[] = [];
      let prevResult: Record<string, unknown> = {};

      for (const { toolName, params } of calls) {
        const resolvedParams = substituteRefs(params, prevResult);
        const finalParams = paramProvider ? mergeParams(resolvedParams, injectedParams) : resolvedParams;
        const result = await client.callTool(
          { name: toolName, arguments: finalParams },
          undefined,
          { timeout: callTimeoutMs },
        );
        const output = toToolCallOutput(result as Record<string, unknown>);
        outputs.push(output);

        // Later steps would be fed the error text through $prev, so a failed step ends the chain.
        if (output.isError) break;

        // Parse result as JSON for $prev substitution in subsequent calls
        try {
          prevResult = JSON.parse(output.text);
        } catch {
          prevResult = { _text: output.text };
        }
      }

      return outputs;
    },
  };
}

/**
 * Connect to an MCP server, invoke a tool, then disconnect.
 */
export async function callTool(
  config: TransportConfig,
  toolName: string,
  params: Record<string, unknown>,
  authProvider?: OAuthClientProvider,
  paramProvider?: ParamProviderConfig,
  envHints?: Record<string, string>,
): Promise<ToolCallOutput> {
  const session = await connectToolSession(config, authProvider, paramProvider, envHints);

  try {
    return await session.callTool(toolName, params);
  } finally {
    await session.close();
  }
}

/**
 * Connect once, invoke multiple tools sequentially in the same session, then disconnect.
 * Supports $prev.field substitution: params referencing "$prev.fieldName" are replaced
 * with the corresponding field from the previous tool's parsed JSON output.
 * Returns one output per executed call; the chain stops after the first call that reports `isError`.
 */
export async function callToolsChained(
  config: TransportConfig,
  calls: ToolCall[],
  authProvider?: OAuthClientProvider,
  paramProvider?: ParamProviderConfig,
  envHints?: Record<string, string>,
): Promise<ToolCallOutput[]> {
  const session = await connectToolSession(config, authProvider, paramProvider, envHints);

  try {
    return await session.callToolsChained(calls);
  } finally {
    await session.close();
  }
}
