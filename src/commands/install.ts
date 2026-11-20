import { Command } from 'commander';
import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import { parseServerInput } from '../client.js';
import { discoverForEntry } from '../discover.js';
import { trySaveSchemaCache } from '../schema-store.js';
import { addServer, getServer } from '../config.js';
import {
  describeAgentSource,
  loadAgentSettings,
  resolveInstallAgentSelection,
  resolveServerAgents,
  saveAgentSettings,
} from '../agent-config.js';
import { detectAgents } from '../generators/index.js';
import { buildRuntimeConfig } from '../runtime-config.js';
import { reconcileSkillFiles } from '../skill-sync.js';
import { writeMetaSkill } from '../meta-skill.js';
import { scrubSecrets } from '../sandbox/redact.js';
import { quoteName, serverNameError } from '../server-name.js';
import { ALL_AGENTS } from '../types.js';
import type {
  AgentSelectionMode,
  AgentType,
  AuthType,
  OAuthConfig,
  ParamProviderConfig,
  Scope,
  ServerEntry,
  ServerRuntimeConfig,
  TransportConfig,
} from '../types.js';

// Derive a short name from server spec
function deriveName(input: string): string {
  // URL -> hostname first segment
  if (input.startsWith('http://') || input.startsWith('https://')) {
    try {
      return new URL(input).hostname.split('.')[0];
    } catch {
      return 'server';
    }
  }
  // npm package: @scope/mcp-server-foo -> foo, server-bar -> bar
  const parts = input.split(/\s+/);
  // find the part that looks like a package name (might be after npx -y etc)
  const pkg = parts.find(p => p.includes('/') || p.startsWith('@') || p.includes('server')) || parts[parts.length - 1];
  const base = pkg.split('/').pop() || pkg;
  // Strip common prefixes
  return base
    .replace(/^@[^/]+\//, '')
    .replace(/(?<=.)@[^@]*$/, '') // a pinned version: bar@1.2.3 -> bar
    .replace(/^mcp-server-/, '')
    .replace(/^server-/, '')
    .replace(/^mcp-/, '');
}

/**
 * Parse an OAuth config object from JSON input.
 */
function parseOAuthConfig(raw: unknown): OAuthConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const config: OAuthConfig = {};
  if (typeof obj.clientId === 'string') config.clientId = obj.clientId;
  if (typeof obj.clientSecret === 'string') config.clientSecret = obj.clientSecret;
  if (typeof obj.callbackPort === 'number') config.callbackPort = obj.callbackPort;
  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * Parse JSON input (inline JSON string, or file contents) into one or more
 * server entries with name and transport config.
 *
 * Supported formats:
 *   1. { "mcpServers": { "<name>": { command/url config } } }  -- multiple servers
 *   2. { "command": "...", "args": [...], "env": {...} }        -- single stdio server
 *   3. { "url": "...", "headers": {...} }                       -- single http/sse server
 */
function parseJsonServers(
  json: Record<string, unknown>,
  nameOverride?: string,
): Array<{ name: string; transport: TransportConfig }> {
  const results: Array<{ name: string; transport: TransportConfig }> = [];

  // Format 1: mcpServers wrapper
  if (json.mcpServers && typeof json.mcpServers === 'object') {
    const servers = json.mcpServers as Record<string, Record<string, unknown>>;
    for (const [serverName, config] of Object.entries(servers)) {
      const transport = jsonEntryToTransport(config);
      results.push({ name: nameOverride && Object.keys(servers).length === 1 ? nameOverride : serverName, transport });
    }
    return results;
  }

  // Format 2: single stdio server
  if (typeof json.command === 'string') {
    const transport: TransportConfig = {
      type: 'stdio',
      command: json.command,
      args: (json.args as string[]) || [],
      ...(json.env ? { env: json.env as Record<string, string> } : {}),
    };
    const name = nameOverride || deriveName(json.command);
    results.push({ name, transport });
    return results;
  }

  // Format 3: single http/sse server
  if (typeof json.url === 'string') {
    const url = json.url as string;
    const type = url.endsWith('/sse') ? 'sse' : 'http';
    const oauth = parseOAuthConfig(json.oauth);
    const transport: TransportConfig = {
      type,
      url,
      ...(json.headers ? { headers: json.headers as Record<string, string> } : {}),
      ...(oauth ? { auth: 'oauth' as const, oauth } : {}),
    } as TransportConfig;
    const name = nameOverride || deriveName(url);
    results.push({ name, transport });
    return results;
  }

  throw new Error('Unrecognized JSON format. Expected mcpServers wrapper, or an object with "command" or "url" key.');
}

/**
 * Convert a single JSON server entry (from within mcpServers) to a TransportConfig.
 */
function jsonEntryToTransport(config: Record<string, unknown>): TransportConfig {
  if (typeof config.command === 'string') {
    return {
      type: 'stdio',
      command: config.command,
      args: (config.args as string[]) || [],
      ...(config.env ? { env: config.env as Record<string, string> } : {}),
    };
  }

  if (typeof config.url === 'string') {
    const url = config.url as string;
    const type = url.endsWith('/sse') ? 'sse' : 'http';
    const oauth = parseOAuthConfig(config.oauth);
    return {
      type,
      url,
      ...(config.headers ? { headers: config.headers as Record<string, string> } : {}),
      ...(oauth ? { auth: 'oauth' as const, oauth } : {}),
    } as TransportConfig;
  }

  throw new Error(`Invalid server entry: must have "command" or "url". Got keys: ${Object.keys(config).join(', ')}`);
}

/**
 * Parse JSON input from a string. Handles:
 *   - Raw JSON string (starts with '{')
 *   - File path ending in .json (reads the file first)
 */
async function parseJsonInput(
  input: string,
  nameOverride?: string,
): Promise<Array<{ name: string; transport: TransportConfig }>> {
  let jsonStr: string;

  if (input.trim().startsWith('{')) {
    // Raw inline JSON
    jsonStr = input;
  } else if (input.trim().endsWith('.json')) {
    // File path
    try {
      jsonStr = await readFile(input.trim(), 'utf-8');
    } catch (err) {
      throw new Error(`Failed to read JSON file "${input.trim()}": ${err instanceof Error ? err.message : err}`);
    }
  } else {
    throw new Error('Input is not JSON. Expected a JSON string starting with { or a .json file path.');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : err}`);
  }

  return parseJsonServers(parsed, nameOverride);
}

/**
 * Detect whether the server-spec input is JSON format.
 * Returns true for raw JSON strings or .json file paths.
 */
function isJsonInput(input: string): boolean {
  const trimmed = input.trim();
  return trimmed.startsWith('{') || trimmed.endsWith('.json');
}

/**
 * Parse a list of `KEY=hint` pairs into a Record. Returns undefined if list is empty.
 * The `=` may appear inside the hint; only the first occurrence splits key from value.
 */
function parseEnvHints(pairs: string[] | undefined): Record<string, string> | undefined {
  if (!pairs || pairs.length === 0) return undefined;
  const hints: Record<string, string> = {};
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) {
      throw new Error(`Invalid --env-hint format "${pair}". Use KEY=hint.`);
    }
    const key = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1);
    if (!key) {
      throw new Error(`Invalid --env-hint format "${pair}". Key is empty.`);
    }
    hints[key] = value;
  }
  return hints;
}

function transportEnv(transport: TransportConfig): Record<string, string> | undefined {
  return transport.type === 'stdio' ? transport.env : undefined;
}

function transportHeaders(transport: TransportConfig): Record<string, string> | undefined {
  return transport.type === 'stdio' ? undefined : transport.headers;
}

/** Names of the keys of `before` that `after` lacks or sets to another value. Never the values: they may be secrets. */
function lostKeys(before: Record<string, string> | undefined, after: Record<string, string> | undefined): string[] {
  return Object.keys(before ?? {}).filter((key) => !after || !Object.hasOwn(after, key) || after[key] !== before?.[key]);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What of the stored entry the new one replaces: a label for each setting, and the option that sets it again. */
function replacedSettings(existing: ServerEntry, next: ServerEntry): Array<{ label: string; option: string }> {
  const replaced: Array<{ label: string; option: string }> = [];
  const keyed = (label: string, option: string, keys: string[]) => {
    if (keys.length > 0) replaced.push({ label: `${label} (${keys.join(', ')})`, option });
  };

  if (existing.description && existing.description !== next.description) {
    replaced.push({ label: 'description', option: '-d/--description' });
  }
  keyed('env', '-e/--env', lostKeys(transportEnv(existing.transport), transportEnv(next.transport)));
  keyed('headers', '--header', lostKeys(transportHeaders(existing.transport), transportHeaders(next.transport)));
  keyed('env hints', '--env-hint', lostKeys(existing.envHints, next.envHints));
  if (existing.paramProvider && !sameJson(existing.paramProvider, next.paramProvider)) {
    replaced.push({ label: 'param provider', option: '--param-provider' });
  }
  if (existing.runtime && !sameJson(existing.runtime, next.runtime)) {
    replaced.push({ label: 'runtime settings', option: '--runtime' });
  }
  if (existing.autoRefresh?.enabled && !(next.autoRefresh?.enabled && existing.autoRefresh.ttlSec === next.autoRefresh.ttlSec)) {
    replaced.push({ label: 'auto-refresh', option: '--auto-refresh' });
  }
  const oauthOf = (transport: TransportConfig) => (
    transport.type === 'stdio' ? undefined : { auth: transport.auth, oauth: transport.oauth }
  );
  const storedOauth = oauthOf(existing.transport);
  if ((storedOauth?.auth !== undefined || storedOauth?.oauth !== undefined) && !sameJson(storedOauth, oauthOf(next.transport))) {
    replaced.push({ label: 'OAuth settings', option: '--auth/--oauth-client-id' });
  }
  const launch = (transport: TransportConfig) => (transport.type === 'stdio'
    ? { type: transport.type, command: transport.command, args: transport.args }
    : { type: transport.type, url: transport.url });
  if (!sameJson(launch(existing.transport), launch(next.transport))) {
    replaced.push({ label: 'command or URL', option: '<server-spec>' });
  }
  return replaced;
}

/**
 * Installing under a name that is registered replaces the whole entry (the skills are regenerated
 * the same way), so say what the new install does not carry over. Settings are named, never their
 * values: env values and headers are often secrets.
 */
function warnAboutReplacement(existing: ServerEntry, next: ServerEntry, dryRun: boolean | undefined): void {
  const verb = dryRun ? 'would replace' : 'replaces';
  const replaced = replacedSettings(existing, next);
  const lines = [`Warning: ${quoteName(existing.name)} is already installed; this install ${verb} its registry entry.`];
  if (replaced.length === 0) {
    lines.push('  Same settings as before: no custom setting is lost.');
  } else {
    lines.push(`  Not carried over: ${replaced.map((item) => item.label).join(', ')}.`);
    lines.push(`  To keep them, pass the options again: ${[...new Set(replaced.map((item) => item.option))].join(', ')}.`);
  }
  console.error(chalk.yellow(lines.join('\n')));
}

/**
 * Install a single server: discover tools, generate skill files, save to registry.
 */
async function installServer(
  name: string,
  transport: TransportConfig,
  opts: {
    env?: string[];
    header?: string[];
    envHint?: string[];
    auth?: AuthType;
    description?: string;
    paramProvider?: string;
    runtimeMode?: string;
    runtimeIdleTimeout?: number;
    runtimeCallTimeout?: number;
    autoRefresh?: boolean;
    autoRefreshTtl?: number;
    dryRun?: boolean;
    scope: Scope;
    agents: AgentType[];
    agentSelectionMode: AgentSelectionMode;
    agentSource: string;
    settingsLoaded: Awaited<ReturnType<typeof loadAgentSettings>>;
  },
): Promise<void> {
  // Apply env vars for stdio (only from CLI flags; JSON env is already in transport)
  if (transport.type === 'stdio' && opts.env?.length) {
    const env: Record<string, string> = { ...transport.env };
    for (const e of opts.env) {
      const [key, ...rest] = e.split('=');
      env[key] = rest.join('=');
    }
    transport.env = env;
  }

  // Apply headers for http/sse (only from CLI flags; JSON headers are already in transport)
  if ((transport.type === 'http' || transport.type === 'sse') && opts.header?.length) {
    const headers: Record<string, string> = { ...(transport as any).headers };
    for (const h of opts.header) {
      const [key, ...rest] = h.split(':');
      headers[key.trim()] = rest.join(':').trim();
    }
    (transport as any).headers = headers;
  }

  // Set auth type on transport
  if (opts.auth && (transport.type === 'http' || transport.type === 'sse')) {
    transport.auth = opts.auth;
  }

  const runtime = buildRuntimeConfig(
    transport,
    opts.runtimeMode,
    opts.runtimeIdleTimeout,
    opts.runtimeCallTimeout,
  );

  console.log(chalk.blue(`Connecting to server "${name}"...`));

  // Discover tools and server metadata (authenticating first when the server uses OAuth).
  // envHints isn't relevant here yet (no entry exists), but a future caller could
  // thread CLI-supplied hints through if needed.
  let discovered: Awaited<ReturnType<typeof discoverForEntry>>;
  try {
    discovered = await discoverForEntry({ name, transport }, { interactiveAuth: true });
  } catch (err) {
    // What the server (or the transport) says may quote the credentials this install was given.
    const given: ServerEntry = {
      name,
      transport,
      ...(opts.paramProvider ? { paramProvider: { command: opts.paramProvider } } : {}),
      toolCount: 0,
      agents: [],
      createdAt: '',
      updatedAt: '',
    };
    throw new Error(scrubSecrets(given, err instanceof Error ? err.message : String(err)));
  }
  const { tools, serverMeta } = discovered;
  console.log(chalk.green(`Found ${tools.length} tool(s)${serverMeta.name ? ` on "${serverMeta.name}"` : ''}:`));
  for (const tool of tools) {
    console.log(`  ${chalk.bold(tool.name)} — ${tool.description || '(no description)'}`);
  }
  if (serverMeta.instructions) {
    console.log(chalk.dim(`\n  Server instructions: ${serverMeta.instructions}`));
  }
  console.log();

  const agents = opts.agents;
  console.log(chalk.dim(`Using agents from ${opts.agentSource}: ${agents.join(', ')}`));
  console.log();

  const scope: Scope = opts.scope || 'global';
  const paramProvider: ParamProviderConfig | undefined = opts.paramProvider
    ? { command: opts.paramProvider }
    : undefined;
  const envHints = parseEnvHints(opts.envHint);
  const ctx = { serverName: name, tools, transport, description: opts.description, serverMeta, scope, runtime, paramProvider };
  const existingEntry = await getServer(name);
  const previousAgents = existingEntry
    ? Array.from(new Set([
      ...existingEntry.agents,
      ...resolveServerAgents(existingEntry, opts.settingsLoaded).agents,
    ]))
    : [];

  const now = new Date().toISOString();
  const runtimeConfig: ServerRuntimeConfig | undefined = runtime;
  const autoRefresh = opts.autoRefresh
    ? {
        enabled: true,
        ...(opts.autoRefreshTtl !== undefined ? { ttlSec: opts.autoRefreshTtl } : {}),
        lastRefreshedAt: now,
      }
    : undefined;
  const entry: ServerEntry = {
    name,
    transport,
    ...(opts.description ? { description: opts.description } : {}),
    ...(paramProvider ? { paramProvider } : {}),
    ...(runtimeConfig ? { runtime: runtimeConfig } : {}),
    ...(envHints ? { envHints } : {}),
    ...(autoRefresh ? { autoRefresh } : {}),
    toolCount: tools.length,
    agents,
    agentSelectionMode: opts.agentSelectionMode,
    createdAt: now,
    updatedAt: now,
  };
  if (existingEntry) warnAboutReplacement(existingEntry, entry, opts.dryRun);

  await reconcileSkillFiles({
    ctx,
    nextAgents: agents,
    previousAgents,
    dryRun: opts.dryRun,
  });

  // Save to registry
  if (!opts.dryRun) {
    await addServer(entry);
    await trySaveSchemaCache(name, tools);
    console.log(chalk.green(`\n✓ Server "${name}" installed with ${tools.length} tools for ${agents.join(', ')} (scope: ${scope})`));
    if (autoRefresh) {
      console.log(chalk.dim(`  auto-refresh enabled (skill regenerates on stale calls)`));
    }
  }
}

/**
 * The servers a spec asks for, with every name checked: the --name value, each key of a JSON
 * `mcpServers` object, and a name derived from the spec. Nothing is installed if any one fails.
 */
async function planServers(
  serverSpec: string,
  opts: { name?: string; oauthClientId?: string; oauthCallbackPort?: number },
): Promise<Array<{ name: string; transport: TransportConfig }>> {
  if (opts.name !== undefined) {
    const error = serverNameError(opts.name);
    if (error) throw error;
  }

  let servers: Array<{ name: string; transport: TransportConfig }>;
  if (isJsonInput(serverSpec)) {
    servers = await parseJsonInput(serverSpec, opts.name);
    if (servers.length === 0) {
      throw new Error('No servers found in JSON input.');
    }
  } else {
    const transport = parseServerInput(serverSpec);
    // Apply OAuth config from CLI flags
    if (opts.oauthClientId && (transport.type === 'http' || transport.type === 'sse')) {
      transport.oauth = {
        clientId: opts.oauthClientId,
        ...(opts.oauthCallbackPort ? { callbackPort: opts.oauthCallbackPort } : {}),
      };
    }
    servers = [{ name: opts.name ?? deriveName(serverSpec), transport }];
  }

  for (const server of servers) {
    const error = serverNameError(server.name);
    if (!error) continue;
    // With one server and no --name, the name came from the spec and --name can replace it.
    throw opts.name === undefined && servers.length === 1
      ? new Error(`${error.message} The name was taken from the spec; pass a valid name with --name.`)
      : error;
  }
  return servers;
}

export function createInstallCommand(): Command {
  return new Command('install')
    .description('Install MCP server tools as agent skills')
    .argument('<server-spec>', 'Server command, npm package, URL, JSON string, or .json file path')
    .option('-n, --name <name>', 'Custom name for the server')
    .option('-a, --agent <agent>', `Target agent(s) (${ALL_AGENTS.join(', ')})`, collect, [] as string[])
    .option('--exclude-agent <agent>', `Skip specific agent(s) (${ALL_AGENTS.join(', ')})`, collect, [] as string[])
    .option('--interactive', 'Interactively configure default agents before installing')
    .option('-e, --env <env>', 'Environment variables (KEY=VALUE)', collect, [] as string[])
    .option('--header <header>', 'HTTP headers (Key: Value)', collect, [] as string[])
    .option('--env-hint <KEY=hint>', 'Custom hint shown when env var KEY is missing at call time. Repeatable. Can include a multi-line shell recipe.', collect, [] as string[])
    .option('--auth <type>', 'Authentication type (oauth or none)')
    .option('--oauth-client-id <id>', 'Pre-registered OAuth client ID (skips dynamic registration)')
    .option('--oauth-callback-port <port>', 'Fixed port for OAuth callback', parseInt)
    .option('--param-provider <command>', 'Shell command that outputs JSON to merge into every tool call\'s params (e.g. credential providers)')
    .option('--runtime <mode>', 'Runtime mode for stdio servers (ephemeral or persistent)')
    .option('--runtime-idle-timeout <seconds>', 'Idle timeout before a persistent stdio runtime shuts down', parseInt)
    .option('--runtime-call-timeout <seconds>', 'Per-call timeout for persistent stdio runtimes', parseInt)
    .option('--auto-refresh', 'Auto re-discover tools + regenerate the skill on stale calls (for dynamic servers)')
    .option('--auto-refresh-ttl <seconds>', 'Staleness window before an auto-refresh triggers (default: 86400)', parseInt)
    .option('-d, --description <text>', 'Custom skill description for agent routing (overrides auto-generated)')
    .option('--scope <scope>', 'Installation scope (global or project)', 'global')
    .option('--dry-run', 'Show what would be generated without writing files')
    .addHelpText('after', `
Examples:
  $ mcpkit install @modelcontextprotocol/server-github
  $ mcpkit install https://mcp.example.com/sse
  $ mcpkit install ./config.json
  $ mcpkit install '{"mcpServers":{"gh":{"command":"npx","args":["-y","@modelcontextprotocol/server-github"]}}}'
  $ mcpkit install @modelcontextprotocol/server-github -n github -a claude-code --scope project

OAuth servers (with dynamic client registration):
  $ mcpkit install https://mcp.postman.com/mcp --auth oauth -n postman

OAuth servers (with pre-registered client ID):
  $ mcpkit install https://mcp.slack.com/mcp --auth oauth --oauth-client-id 1601185624273.8899143856786 --oauth-callback-port 3118 -n slack

Persistent stdio runtime:
  $ mcpkit install "npx -y @browsermcp/mcp" -n browsermcp --runtime persistent --runtime-idle-timeout 900 --runtime-call-timeout 3600`)
    .action(async (serverSpec: string, opts) => {
      try {
        // Parse the spec and check every name first: a bad name must be refused before anything is
        // written (agent settings included) or started (the server's command).
        const fromJson = isJsonInput(serverSpec);
        const servers = await planServers(serverSpec, opts);

        const detectedAgents = detectAgents();
        const settings = await loadAgentSettings();
        const agentSelection = await resolveInstallAgentSelection({
          includeAgents: opts.agent,
          excludeAgents: opts.excludeAgent,
          interactive: opts.interactive,
          detectedAgents,
          settings,
        });

        if (agentSelection.settingsToSave && !opts.dryRun) {
          await saveAgentSettings(agentSelection.settingsToSave);
          console.log(chalk.green(`✓ Saved default agents: ${agentSelection.settingsToSave.enabledAgents.join(', ')}`));
          console.log();
        }

        const agentSource = describeAgentSource(agentSelection.source);

        if (fromJson) {
          console.log(chalk.blue(`Parsed ${servers.length} server(s) from JSON input.\n`));
        }

        for (const server of servers) {
          await installServer(server.name, server.transport, {
            env: opts.env,
            header: opts.header,
            envHint: opts.envHint,
            auth: opts.auth,
            description: opts.description,
            paramProvider: opts.paramProvider,
            runtimeMode: opts.runtime,
            runtimeIdleTimeout: opts.runtimeIdleTimeout,
            runtimeCallTimeout: opts.runtimeCallTimeout,
            autoRefresh: opts.autoRefresh,
            autoRefreshTtl: opts.autoRefreshTtl,
            dryRun: opts.dryRun,
            scope: opts.scope || 'global',
            agents: agentSelection.agents,
            agentSelectionMode: agentSelection.selectionMode,
            agentSource,
            settingsLoaded: agentSelection.settingsToSave ?? settings,
          });
        }

        // Refresh the mcpkit-cli meta-skill once per install, for the same agents.
        await writeMetaSkill({
          agents: agentSelection.agents,
          scope: opts.scope || 'global',
          dryRun: opts.dryRun,
        });
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}
