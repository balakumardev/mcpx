import { Command } from 'commander';
import { createInstallCommand } from './commands/install.js';
import { createCallCommand } from './commands/call.js';
import { createListCommand } from './commands/list.js';
import { createRemoveCommand } from './commands/remove.js';
import { createUpdateCommand } from './commands/update.js';

const program = new Command()
  .name('mcpkit')
  .description('Turn any MCP server into CLI commands + lightweight agent skills')
  .version(__PKG_VERSION__);

program.addCommand(createInstallCommand());
program.addCommand(createCallCommand());
program.addCommand(createListCommand());
program.addCommand(createRemoveCommand());
program.addCommand(createUpdateCommand());

program.parse();
