import { Command } from 'commander';
import chalk from 'chalk';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseServerInput, discoverTools } from '../client.js';
import { addServer } from '../config.js';
import { getGenerator, detectAgents } from '../generators/index.js';
import type { AgentType, Scope, ServerEntry, TransportConfig } from '../types.js';

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
    .replace(/^mcp-server-/, '')
    .replace(/^server-/, '')
    .replace(/^mcp-/, '');
}

// Write a generated skill file
async function writeSkillFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
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
    const transport: TransportConfig = {
      type,
      url,
      ...(json.headers ? { headers: json.headers as Record<string, string> } : {}),
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
    return {
      type,
      url,
      ...(config.headers ? { headers: config.headers as Record<string, string> } : {}),
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
 * Install a single server: discover tools, generate skill files, save to registry.
 */
async function installServer(
  name: string,
  transport: TransportConfig,
  opts: {
    agent: string[];
    env?: string[];
    header?: string[];
    dryRun?: boolean;
    scope: Scope;
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

  console.log(chalk.blue(`Connecting to server "${name}"...`));

  // Discover tools
  const tools = await discoverTools(transport);
  console.log(chalk.green(`Found ${tools.length} tool(s):`));
  for (const tool of tools) {
    console.log(`  ${chalk.bold(tool.name)} — ${tool.description || '(no description)'}`);
  }
  console.log();

  // Determine target agents
  let agents: AgentType[] = opts.agent.length > 0
    ? opts.agent as AgentType[]
    : detectAgents();

  if (agents.length === 0) {
    agents = ['claude-code']; // Default fallback
  }

  // Generate skill files
  const scope: Scope = opts.scope || 'global';
  const ctx = { serverName: name, tools, transport, description: undefined, scope };

  for (const agent of agents) {
    const generate = await getGenerator(agent);
    const skill = generate(ctx);

    if (opts.dryRun) {
      console.log(chalk.yellow(`[dry-run] ${agent}: ${skill.filePath}`));
      console.log(chalk.dim(skill.content.slice(0, 200) + '...'));
      console.log();
    } else {
      await writeSkillFile(skill.filePath, skill.content);
      console.log(chalk.green(`✓ ${agent}: ${skill.filePath}`));
    }
  }

  // Save to registry
  if (!opts.dryRun) {
    const now = new Date().toISOString();
    const entry: ServerEntry = {
      name,
      transport,
      toolCount: tools.length,
      agents,
      createdAt: now,
      updatedAt: now,
    };
    await addServer(entry);
    console.log(chalk.green(`\n✓ Server "${name}" installed with ${tools.length} tools for ${agents.join(', ')} (scope: ${scope})`));
  }
}

export function createInstallCommand(): Command {
  return new Command('install')
    .description('Install MCP server tools as agent skills')
    .argument('<server-spec>', 'Server command, npm package, URL, JSON string, or .json file path')
    .option('-n, --name <name>', 'Custom name for the server')
    .option('-a, --agent <agent>', 'Target agent(s)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('-e, --env <env>', 'Environment variables (KEY=VALUE)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--header <header>', 'HTTP headers (Key: Value)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--scope <scope>', 'Installation scope', 'global')
    .option('--dry-run', 'Show what would be generated without writing files')
    .action(async (serverSpec: string, opts) => {
      try {
        if (isJsonInput(serverSpec)) {
          // JSON format: parse into one or more servers
          const servers = await parseJsonInput(serverSpec, opts.name);

          if (servers.length === 0) {
            throw new Error('No servers found in JSON input.');
          }

          console.log(chalk.blue(`Parsed ${servers.length} server(s) from JSON input.\n`));

          for (const server of servers) {
            await installServer(server.name, server.transport, {
              agent: opts.agent,
              env: opts.env,
              header: opts.header,
              dryRun: opts.dryRun,
              scope: opts.scope || 'global',
            });
          }
        } else {
          // String format: existing behavior (single server)
          const transport = parseServerInput(serverSpec);
          const name = opts.name || deriveName(serverSpec);

          await installServer(name, transport, {
            agent: opts.agent,
            env: opts.env,
            header: opts.header,
            dryRun: opts.dryRun,
            scope: opts.scope || 'global',
          });
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
