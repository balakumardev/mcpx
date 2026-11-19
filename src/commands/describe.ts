import { Command } from 'commander';
import chalk from 'chalk';
import { loadRegistry } from '../config.js';
import { getToolsForServer } from '../discover.js';
import { buildCallExample } from '../codegen/example-args.js';
import { escapeControlChars, jsonLine, nearestNames, registeredServer, unknownServerMessage } from '../search-index.js';

/**
 * `text` as a terminal can safely show it: every control character (ESC, CR, the
 * C1 controls, DEL) and the Unicode line and paragraph separators becomes a
 * visible `\uNNNN` escape. Newlines and tabs stay, because a description and a
 * pretty-printed schema need them. JSON.stringify leaves DEL, the C1 controls
 * and U+2028/9 raw, so schema text goes through this too; the escapes are valid
 * JSON string escapes, so the schema still parses.
 */
function visible(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (char) => (char === '\n' || char === '\t' ? char : escapeControlChars(char)));
}

/** Most lines of the output schema printed in text mode; `--json` prints it whole. */
const OUTPUT_SCHEMA_MAX_LINES = 60;

/** The pretty-printed output schema, cut after `OUTPUT_SCHEMA_MAX_LINES` lines with a count of what was left out. */
function printedOutputSchema(schema: Record<string, unknown>): string {
  const lines = visible(JSON.stringify(schema, null, 2)).split('\n');
  if (lines.length <= OUTPUT_SCHEMA_MAX_LINES) return lines.join('\n');
  const hidden = lines.length - OUTPUT_SCHEMA_MAX_LINES;
  return [
    ...lines.slice(0, OUTPUT_SCHEMA_MAX_LINES),
    `... ${hidden} more line${hidden === 1 ? '' : 's'}; use --json for the full output schema`,
  ].join('\n');
}

export function createDescribeCommand(): Command {
  return new Command('describe')
    .description('Show the full schema and a ready example call for one tool')
    .argument('<server>', 'Registered server name')
    .argument('<tool>', 'Tool name')
    .option('--json', 'Print the result as JSON')
    .addHelpText('after', `
Uses the schema cache, and fetches (and caches) the tools if the server has none yet.
Text mode prints at most 60 lines of the output schema; --json prints all of it.

Examples:
  $ mcpkit describe github create_issue
  $ mcpkit describe github create_issue --json`)
    .action(async (server: string, toolName: string, options: { json?: boolean }) => {
      try {
        const registry = await loadRegistry();
        const entry = registeredServer(registry.servers, server);
        if (!entry) {
          console.error(chalk.red(unknownServerMessage(server, Object.keys(registry.servers))));
          process.exitCode = 1;
          return;
        }

        const { tools } = await getToolsForServer(entry);
        const tool = tools.find((candidate) => candidate.name === toolName);
        if (!tool) {
          const nearest = nearestNames(toolName, tools.map((candidate) => candidate.name));
          const hint = nearest.length > 0 ? ` Nearest: ${nearest.map(escapeControlChars).join(', ')}.` : '';
          const shownServer = escapeControlChars(server);
          console.error(chalk.red(`Tool "${escapeControlChars(toolName)}" not found on server "${shownServer}".${hint} Run \`mcpkit search <keywords> --server ${shownServer}\` to look for it.`));
          process.exitCode = 1;
          return;
        }

        const example = buildCallExample(server, tool.name, tool.inputSchema);
        if (options.json) {
          console.log(jsonLine({
            server,
            tool: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            annotations: tool.annotations,
            example,
          }));
          return;
        }

        const lines = [`${escapeControlChars(server)}.${escapeControlChars(tool.name)}`];
        if (tool.title) lines.push(`Title: ${escapeControlChars(tool.title)}`);
        lines.push('', visible(tool.description.trim()) || '(no description)', '');
        lines.push('Parameters (JSON Schema):', visible(JSON.stringify(tool.inputSchema, null, 2)), '');
        lines.push('Output schema:', tool.outputSchema ? printedOutputSchema(tool.outputSchema) : 'not declared', '');
        lines.push('Annotations (server-declared, untrusted):');
        const annotations = Object.entries(tool.annotations ?? {});
        lines.push(...(annotations.length > 0
          ? annotations.map(([key, value]) => `  ${escapeControlChars(key)}: ${visible(JSON.stringify(value))}`)
          : ['  none declared']));
        lines.push('', 'Example:', `  ${example}`);
        console.log(lines.join('\n'));
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`));
        process.exitCode = 1;
      }
    });
}
