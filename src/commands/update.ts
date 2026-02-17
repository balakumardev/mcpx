import { Command } from 'commander';
import chalk from 'chalk';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getServer, listServers, addServer } from '../config.js';
import { discoverTools } from '../client.js';
import { getGenerator } from '../generators/index.js';

// Same writeSkillFile helper as install
async function writeSkillFile(filePath: string, content: string, isAppend: boolean): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });

  if (isAppend) {
    let existing = '';
    try { existing = await readFile(filePath, 'utf-8'); } catch { /* empty */ }

    const startMarker = content.match(/<!-- mcpx:start:(\S+) -->/)?.[0];
    const endMarker = content.match(/<!-- mcpx:end:(\S+) -->/)?.[0];

    if (startMarker && endMarker && existing.includes(startMarker)) {
      const regex = new RegExp(
        `${startMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${endMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      );
      await writeFile(filePath, existing.replace(regex, content), 'utf-8');
    } else {
      const separator = existing && !existing.endsWith('\n') ? '\n\n' : existing ? '\n' : '';
      await writeFile(filePath, existing + separator + content, 'utf-8');
    }
  } else {
    await writeFile(filePath, content, 'utf-8');
  }
}

export function createUpdateCommand(): Command {
  return new Command('update')
    .description('Re-discover tools and regenerate skill files')
    .argument('[name]', 'Server name (omit to update all)')
    .action(async (name?: string) => {
      try {
        const servers = name ? [await getServer(name)].filter(Boolean) : await listServers();

        if (servers.length === 0) {
          console.log(chalk.yellow(name ? `Server "${name}" not found.` : 'No servers registered.'));
          return;
        }

        for (const entry of servers) {
          if (!entry) continue;
          console.log(chalk.blue(`Updating ${entry.name}...`));

          const tools = await discoverTools(entry.transport);
          console.log(`  Found ${tools.length} tool(s)`);

          const ctx = { serverName: entry.name, tools, transport: entry.transport, scope: 'global' as const };

          for (const agent of entry.agents) {
            const generate = await getGenerator(agent);
            const skill = generate(ctx);
            await writeSkillFile(skill.filePath, skill.content, skill.isAppend);
            console.log(chalk.green(`  ✓ ${agent}: ${skill.filePath}`));
          }

          entry.toolCount = tools.length;
          entry.updatedAt = new Date().toISOString();
          await addServer(entry);
        }

        console.log(chalk.green(`\n✓ Updated ${servers.length} server(s)`));
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
