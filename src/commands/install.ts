import { Command } from 'commander';
import chalk from 'chalk';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseServerInput, discoverTools } from '../client.js';
import { addServer } from '../config.js';
import { getGenerator, detectAgents } from '../generators/index.js';
import type { AgentType, ServerEntry, TransportConfig } from '../types.js';

// Derive a short name from server spec
function deriveName(input: string): string {
  // URL → hostname first segment
  if (input.startsWith('http://') || input.startsWith('https://')) {
    try {
      return new URL(input).hostname.split('.')[0];
    } catch {
      return 'server';
    }
  }
  // npm package: @scope/mcp-server-foo → foo, server-bar → bar
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

// Write a generated skill file (handle append mode for codex)
async function writeSkillFile(filePath: string, content: string, isAppend: boolean): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });

  if (isAppend) {
    // For codex: read existing file, replace section if exists, or append
    let existing = '';
    try {
      existing = await readFile(filePath, 'utf-8');
    } catch {
      // File doesn't exist yet
    }

    // Extract server name from section markers
    const startMarker = content.match(/<!-- mcpx:start:(\S+) -->/)?.[0];
    const endMarker = content.match(/<!-- mcpx:end:(\S+) -->/)?.[0];

    if (startMarker && endMarker && existing.includes(startMarker)) {
      // Replace existing section
      const regex = new RegExp(
        `${escapeRegex(startMarker)}[\\s\\S]*?${escapeRegex(endMarker)}`,
      );
      const updated = existing.replace(regex, content);
      await writeFile(filePath, updated, 'utf-8');
    } else {
      // Append to file
      const separator = existing && !existing.endsWith('\n') ? '\n\n' : existing ? '\n' : '';
      await writeFile(filePath, existing + separator + content, 'utf-8');
    }
  } else {
    await writeFile(filePath, content, 'utf-8');
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createInstallCommand(): Command {
  return new Command('install')
    .description('Install MCP server tools as agent skills')
    .argument('<server-spec>', 'Server command, npm package, or URL')
    .option('-n, --name <name>', 'Custom name for the server')
    .option('-a, --agent <agent>', 'Target agent(s)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('-e, --env <env>', 'Environment variables (KEY=VALUE)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--header <header>', 'HTTP headers (Key: Value)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--dry-run', 'Show what would be generated without writing files')
    .action(async (serverSpec: string, opts) => {
      try {
        // 1. Parse transport config
        const transport = parseServerInput(serverSpec);

        // Apply env vars for stdio
        if (transport.type === 'stdio' && opts.env?.length) {
          const env: Record<string, string> = {};
          for (const e of opts.env) {
            const [key, ...rest] = e.split('=');
            env[key] = rest.join('=');
          }
          transport.env = env;
        }

        // Apply headers for http/sse
        if ((transport.type === 'http' || transport.type === 'sse') && opts.header?.length) {
          const headers: Record<string, string> = {};
          for (const h of opts.header) {
            const [key, ...rest] = h.split(':');
            headers[key.trim()] = rest.join(':').trim();
          }
          transport.headers = headers;
        }

        // 2. Derive name
        const name = opts.name || deriveName(serverSpec);
        console.log(chalk.blue(`Connecting to server...`));

        // 3. Discover tools
        const tools = await discoverTools(transport);
        console.log(chalk.green(`Found ${tools.length} tool(s):`));
        for (const tool of tools) {
          console.log(`  ${chalk.bold(tool.name)} — ${tool.description || '(no description)'}`);
        }
        console.log();

        // 4. Determine target agents
        let agents: AgentType[] = opts.agent.length > 0
          ? opts.agent as AgentType[]
          : detectAgents();

        if (agents.length === 0) {
          agents = ['claude-code']; // Default fallback
        }

        // 5. Generate skill files
        const ctx = { serverName: name, tools, transport, description: undefined };

        for (const agent of agents) {
          const generate = await getGenerator(agent);
          const skill = generate(ctx);

          if (opts.dryRun) {
            console.log(chalk.yellow(`[dry-run] ${agent}: ${skill.filePath}`));
            console.log(chalk.dim(skill.content.slice(0, 200) + '...'));
            console.log();
          } else {
            await writeSkillFile(skill.filePath, skill.content, skill.isAppend);
            console.log(chalk.green(`✓ ${agent}: ${skill.filePath}`));
          }
        }

        // 6. Save to registry
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
          console.log(chalk.green(`\n✓ Server "${name}" installed with ${tools.length} tools for ${agents.join(', ')}`));
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
