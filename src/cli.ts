import { Command } from 'commander';
import { createInstallCommand } from './commands/install.js';
import { createCallCommand } from './commands/call.js';
import { createListCommand } from './commands/list.js';
import { createRemoveCommand } from './commands/remove.js';
import { createUpdateCommand } from './commands/update.js';

const program = new Command()
  .name('mcpx')
  .description('Universal MCP-to-Agent Skill Installer')
  .version('0.1.0');

program.addCommand(createInstallCommand());
program.addCommand(createCallCommand());
program.addCommand(createListCommand());
program.addCommand(createRemoveCommand());
program.addCommand(createUpdateCommand());

program.parse();
