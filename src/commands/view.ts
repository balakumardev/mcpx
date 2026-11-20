import { Command } from 'commander';
import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { stringify } from 'yaml';
import { getServer, getRegistryPath } from '../config.js';
import { loadAgentSettings, resolveServerAgents } from '../agent-config.js';
import { resolveRuntimeConfig } from '../runtime-config.js';
import { maskEntryForDisplay } from '../redact-config.js';
import { DEFAULT_AUTO_REFRESH_TTL_SEC, type ServerEntry } from '../types.js';

export function createViewCommand(): Command {
  return new Command('view')
    .description('Show full config for a registered server')
    .argument('<name>', 'Server name to view')
    .option('--yaml', 'Output YAML for the entry as stored')
    .option('--json', 'Output JSON instead of text')
    .option('--reveal', 'Print secrets (env values, headers, arguments, URL keys) in clear text instead of <redacted len=N>')
    .addHelpText('after', `
Examples:
  $ mcpkit view github
  $ mcpkit view github --yaml
  $ mcpkit view github --json

Secrets are masked by default in every format. --reveal prints them as stored: keep that output
out of logs, shared terminals and agent transcripts.`)
    .action(async (name: string, opts: { yaml?: boolean; json?: boolean; reveal?: boolean }) => {
      try {
        const entry = await getServer(name);
        if (!entry) {
          console.error(chalk.red(`Server "${name}" not found. Run 'mcpkit list' to see registered servers.`));
          process.exit(1);
        }
        const settings = await loadAgentSettings();
        const resolved = resolveServerAgents(entry, settings);
        if (opts.reveal) {
          console.error(chalk.yellow('Warning: --reveal prints secrets in clear text; do not paste this output into logs, chats or agent transcripts.'));
        }
        const show = (value: ServerEntry): ServerEntry => (opts.reveal ? value : maskEntryForDisplay(value));

        if (opts.yaml) {
          const content = await readFile(getRegistryPath(), 'utf-8');
          const registry = parse(content);
          console.log(stringify({ [name]: show(registry.servers[name]) }).trim());
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify({ ...show(entry), agents: resolved.agents, agentSelectionMode: resolved.selectionMode }, null, 2));
          return;
        }

        // Everything below prints the masked copy, never `entry` itself.
        const shown = show(entry);

        // Formatted output
        console.log(chalk.bold(`\n${name}\n`));

        if (shown.description) {
          console.log(`  ${chalk.dim(shown.description)}\n`);
        }

        // Transport
        console.log(chalk.blue('Transport'));
        console.log(`  Type:    ${shown.transport.type}`);

        if (shown.transport.type === 'stdio') {
          console.log(`  Command: ${shown.transport.command}`);
          if (shown.transport.args.length > 0) {
            console.log(`  Args:    ${shown.transport.args.join(' ')}`);
          }

          if (shown.transport.env && Object.keys(shown.transport.env).length > 0) {
            console.log(chalk.blue('\nEnv Vars'));
            for (const [key, value] of Object.entries(shown.transport.env)) {
              console.log(`  ${key}=${value}`);
            }
          }
        } else {
          console.log(`  URL:     ${shown.transport.url}`);

          if (shown.transport.auth) {
            console.log(`  Auth:    ${shown.transport.auth}`);
          }

          if (shown.transport.headers && Object.keys(shown.transport.headers).length > 0) {
            console.log(chalk.blue('\nHeaders'));
            for (const [key, value] of Object.entries(shown.transport.headers)) {
              console.log(`  ${key}: ${value}`);
            }
          }
        }

        // Param provider
        if (shown.paramProvider) {
          console.log(chalk.blue('\nParam Provider'));
          console.log(`  Command: ${shown.paramProvider.command}${shown.paramProvider.args ? ' ' + shown.paramProvider.args.join(' ') : ''}`);
          if (shown.paramProvider.ttl) {
            console.log(`  TTL:     ${shown.paramProvider.ttl}s`);
          }
        }

        // Env hints (surfaced when a referenced env var is missing at call time)
        if (shown.envHints && Object.keys(shown.envHints).length > 0) {
          console.log(chalk.blue('\nEnv Hints'));
          for (const [key, value] of Object.entries(shown.envHints)) {
            const lines = value.split('\n');
            console.log(`  ${chalk.bold(key)}:`);
            for (const line of lines) {
              console.log(`    ${chalk.dim(line)}`);
            }
          }
        }

        if (entry.transport.type === 'stdio') {
          const runtime = resolveRuntimeConfig(entry.runtime);
          console.log(chalk.blue('\nRuntime'));
          console.log(`  Mode:    ${runtime.mode}`);
          console.log(`  Idle:    ${runtime.idleTimeoutSec}s`);
          console.log(`  Call:    ${runtime.callTimeoutSec}s`);
        }

        // Auto-refresh (skill regeneration for dynamic servers)
        console.log(chalk.blue('\nAuto-refresh'));
        if (entry.autoRefresh?.enabled) {
          const ttl = entry.autoRefresh.ttlSec ?? DEFAULT_AUTO_REFRESH_TTL_SEC;
          console.log(`  Enabled: yes`);
          console.log(`  TTL:     ${ttl}s`);
          if (entry.autoRefresh.lastRefreshedAt) {
            console.log(`  Last:    ${entry.autoRefresh.lastRefreshedAt}`);
          }
        } else {
          console.log(`  Enabled: no ${chalk.dim('(enable with `mcpkit edit ' + name + ' --auto-refresh`)')}`);
        }

        // Metadata
        console.log(chalk.blue('\nMetadata'));
        console.log(`  Tools:   ${entry.toolCount}`);
        console.log(`  Agents:  ${resolved.agents.join(', ')}`);
        console.log(`  Mode:    ${resolved.selectionMode}`);
        console.log(`  Created: ${entry.createdAt}`);
        console.log(`  Updated: ${entry.updatedAt}`);
        console.log();
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
