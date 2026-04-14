import { Command } from 'commander';
import chalk from 'chalk';
import { getServer, addServer, removeServer } from '../config.js';
import { loadAgentSettings, normalizeAgentList, resolveServerAgents } from '../agent-config.js';
import { getGenerator } from '../generators/index.js';
import { removeSkillDirectory } from '../skill-file.js';
import { ALL_AGENTS } from '../types.js';
import type { AgentType } from '../types.js';

export function createEditCommand(): Command {
  return new Command('edit')
    .description('Modify config for a registered server')
    .argument('<name>', 'Server name to edit')
    .option('--env <KEY=VALUE>', 'Add/update an env var (stdio only)', collect, [])
    .option('--remove-env <KEY>', 'Remove an env var (stdio only)', collect, [])
    .option('--header <Key: Value>', 'Add/update a header (http/sse only)', collect, [])
    .option('--remove-header <KEY>', 'Remove a header (http/sse only)', collect, [])
    .option('--add-agent <agent>', `Add an agent (${ALL_AGENTS.join(', ')})`, collect, [])
    .option('--remove-agent <agent>', `Remove an agent (${ALL_AGENTS.join(', ')})`, collect, [])
    .option('--use-defaults', 'Use global default agents instead of explicit list')
    .option('--auth <type>', 'Set auth type (oauth or none)')
    .option('--oauth-client-id <id>', 'Set pre-registered OAuth client ID')
    .option('--oauth-callback-port <port>', 'Set fixed OAuth callback port', parseInt)
    .option('--param-provider <command>', 'Set a shell command that outputs JSON to merge into tool call params')
    .option('--remove-param-provider', 'Remove the param provider')
    .option('--description <text>', 'Set server description')
    .option('--name <new-name>', 'Rename the server')
    .addHelpText('after', `
Examples:
  $ mcpkit edit github --env GITHUB_TOKEN=ghp_xxx
  $ mcpkit edit github --remove-env GITHUB_TOKEN
  $ mcpkit edit myapi --header "Authorization: Bearer tok_xxx"
  $ mcpkit edit myapi --description "My custom API server"
  $ mcpkit edit github --name gh

Add/remove agents:
  $ mcpkit edit obsidian-search --add-agent claude-code
  $ mcpkit edit obsidian-search --remove-agent codex
  $ mcpkit edit obsidian-search --use-defaults

Enable/disable OAuth:
  $ mcpkit edit postman --auth oauth    # Then run: mcpkit auth postman
  $ mcpkit edit postman --auth none     # Remove OAuth

Pre-registered OAuth (servers without dynamic client registration):
  $ mcpkit edit slack --oauth-client-id 1601185624273.8899143856786 --oauth-callback-port 3118`)
    .action(async (name: string, opts) => {
      try {
        const entry = await getServer(name);
        if (!entry) {
          console.error(chalk.red(`Server "${name}" not found. Run 'mcpkit list' to see registered servers.`));
          process.exit(1);
        }

        let changed = false;
        let currentAgents: AgentType[] = entry.agents;
        let trackedAgents = new Set(entry.agents);

        if (
          (opts.addAgent && (opts.addAgent as string[]).length > 0)
          || (opts.removeAgent && (opts.removeAgent as string[]).length > 0)
        ) {
          const settings = await loadAgentSettings();
          const resolved = resolveServerAgents(entry, settings);
          currentAgents = resolved.agents;
          trackedAgents = new Set([...entry.agents, ...resolved.agents]);
        }

        // --add-agent
        if (opts.addAgent && (opts.addAgent as string[]).length > 0) {
          const agentsToAdd = normalizeAgentList(opts.addAgent as string[], 'agent');
          const currentAgentSet = new Set(currentAgents);
          for (const agent of agentsToAdd) {
            if (currentAgentSet.has(agent)) {
              console.log(chalk.yellow(`Agent "${agent}" already exists for "${name}".`));
            } else {
              currentAgentSet.add(agent);
              trackedAgents.add(agent);
              console.log(chalk.green(`✓ Added agent ${agent}`));
              changed = true;
            }
          }
          currentAgents = Array.from(currentAgentSet);
          entry.agents = currentAgents;
          entry.agentSelectionMode = 'explicit';
        }

        // --remove-agent
        if (opts.removeAgent && (opts.removeAgent as string[]).length > 0) {
          const agentsToRemove = normalizeAgentList(opts.removeAgent as string[], 'agent');
          const agentsToRemoveSet = new Set(agentsToRemove);
          const matchingAgents = agentsToRemove.filter(agent => trackedAgents.has(agent));

          if (matchingAgents.length > 0) {
            const ctx = {
              serverName: name,
              tools: [],
              transport: entry.transport,
              description: entry.description,
              scope: 'global' as const,
            };

            for (const agent of matchingAgents) {
              const generate = await getGenerator(agent);
              const skill = generate(ctx);

              try {
                await removeSkillDirectory(skill.filePath);
              } catch {
                // Ignore missing skill directories so registry edits can still proceed.
              }
            }

            currentAgents = currentAgents.filter(agent => !agentsToRemoveSet.has(agent));
            entry.agents = currentAgents;
            entry.agentSelectionMode = 'explicit';
            console.log(chalk.green(`✓ Removed ${matchingAgents.length} agent(s)`));
            changed = true;
          } else {
            console.log(chalk.yellow('No matching agents to remove.'));
          }
          if (currentAgents.length === 0) {
            console.warn(chalk.yellow('Warning: No agents remaining. Will use fallback on next sync.'));
          }
        }

        // --use-defaults
        if (opts.useDefaults) {
          entry.agentSelectionMode = 'defaults';
          console.log(chalk.green(`✓ Set to use global default agents`));
          changed = true;
        }

        // --env KEY=VALUE
        for (const pair of opts.env as string[]) {
          if (!pair.includes('=')) {
            console.error(chalk.red(`Invalid env format "${pair}". Use KEY=VALUE.`));
            process.exit(1);
          }
          if (entry.transport.type !== 'stdio') {
            console.warn(chalk.yellow(`Warning: --env is only for stdio servers. "${name}" uses ${entry.transport.type}.`));
            continue;
          }
          const eqIdx = pair.indexOf('=');
          const key = pair.slice(0, eqIdx);
          const value = pair.slice(eqIdx + 1);
          entry.transport.env = entry.transport.env || {};
          entry.transport.env[key] = value;
          console.log(chalk.green(`✓ Set env ${key}`));
          changed = true;
        }

        // --remove-env KEY
        for (const key of opts.removeEnv as string[]) {
          if (entry.transport.type !== 'stdio') {
            console.warn(chalk.yellow(`Warning: --remove-env is only for stdio servers. "${name}" uses ${entry.transport.type}.`));
            continue;
          }
          if (entry.transport.env && key in entry.transport.env) {
            delete entry.transport.env[key];
            if (Object.keys(entry.transport.env).length === 0) {
              delete entry.transport.env;
            }
            console.log(chalk.green(`✓ Removed env ${key}`));
            changed = true;
          } else {
            console.warn(chalk.yellow(`Env var "${key}" not found.`));
          }
        }

        // --header "Key: Value"
        for (const raw of opts.header as string[]) {
          const colonIdx = raw.indexOf(':');
          if (colonIdx === -1) {
            console.error(chalk.red(`Invalid header format "${raw}". Use "Key: Value".`));
            process.exit(1);
          }
          if (entry.transport.type === 'stdio') {
            console.warn(chalk.yellow(`Warning: --header is only for http/sse servers. "${name}" uses stdio.`));
            continue;
          }
          const key = raw.slice(0, colonIdx).trim();
          const value = raw.slice(colonIdx + 1).trim();
          entry.transport.headers = entry.transport.headers || {};
          entry.transport.headers[key] = value;
          console.log(chalk.green(`✓ Set header ${key}`));
          changed = true;
        }

        // --remove-header KEY
        for (const key of opts.removeHeader as string[]) {
          if (entry.transport.type === 'stdio') {
            console.warn(chalk.yellow(`Warning: --remove-header is only for http/sse servers. "${name}" uses stdio.`));
            continue;
          }
          if (entry.transport.headers && key in entry.transport.headers) {
            delete entry.transport.headers[key];
            if (Object.keys(entry.transport.headers).length === 0) {
              delete entry.transport.headers;
            }
            console.log(chalk.green(`✓ Removed header ${key}`));
            changed = true;
          } else {
            console.warn(chalk.yellow(`Header "${key}" not found.`));
          }
        }

        // --auth
        if (opts.auth !== undefined) {
          if (entry.transport.type === 'stdio') {
            console.warn(chalk.yellow(`Warning: --auth is only for http/sse servers. "${name}" uses stdio.`));
          } else if (opts.auth === 'none') {
            delete entry.transport.auth;
            console.log(chalk.green(`✓ Removed auth`));
            changed = true;
          } else if (opts.auth === 'oauth') {
            entry.transport.auth = 'oauth';
            console.log(chalk.green(`✓ Set auth to oauth`));
            changed = true;
          } else {
            console.error(chalk.red(`Invalid auth type "${opts.auth}". Use "oauth" or "none".`));
            process.exit(1);
          }
        }

        // --oauth-client-id / --oauth-callback-port
        if (opts.oauthClientId !== undefined || opts.oauthCallbackPort !== undefined) {
          if (entry.transport.type === 'stdio') {
            console.warn(chalk.yellow(`Warning: OAuth options are only for http/sse servers. "${name}" uses stdio.`));
          } else {
            entry.transport.oauth = entry.transport.oauth || {};
            if (opts.oauthClientId !== undefined) {
              entry.transport.oauth.clientId = opts.oauthClientId;
              console.log(chalk.green(`✓ Set OAuth client ID`));
              changed = true;
            }
            if (opts.oauthCallbackPort !== undefined) {
              entry.transport.oauth.callbackPort = opts.oauthCallbackPort;
              console.log(chalk.green(`✓ Set OAuth callback port to ${opts.oauthCallbackPort}`));
              changed = true;
            }
          }
        }

        // --param-provider
        if (opts.paramProvider !== undefined) {
          entry.paramProvider = { command: opts.paramProvider };
          console.log(chalk.green(`✓ Set param provider: ${opts.paramProvider}`));
          changed = true;
        }

        // --remove-param-provider
        if (opts.removeParamProvider) {
          if (entry.paramProvider) {
            delete entry.paramProvider;
            console.log(chalk.green(`✓ Removed param provider`));
            changed = true;
          } else {
            console.warn(chalk.yellow('No param provider configured.'));
          }
        }

        // --description
        if (opts.description !== undefined) {
          entry.description = opts.description;
          console.log(chalk.green(`✓ Set description`));
          changed = true;
        }

        // --name (rename)
        const newName = opts.name as string | undefined;
        if (newName) {
          const existing = await getServer(newName);
          if (existing) {
            console.error(chalk.red(`Server "${newName}" already exists. Choose a different name.`));
            process.exit(1);
          }
          await removeServer(name);
          entry.name = newName;
          entry.updatedAt = new Date().toISOString();
          await addServer(entry);
          console.log(chalk.green(`✓ Renamed "${name}" → "${newName}"`));
          return;
        }

        if (changed) {
          entry.updatedAt = new Date().toISOString();
          await addServer(entry);
        } else {
          console.log(chalk.yellow('No changes specified. Use --help to see options.'));
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}
