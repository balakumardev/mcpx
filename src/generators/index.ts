import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { AgentType, GeneratorContext, GeneratedSkill, ToolInfo, ServerRuntimeConfig } from '../types.js';
import { DEFAULT_RUNTIME_IDLE_TIMEOUT_SEC, DEFAULT_RUNTIME_CALL_TIMEOUT_SEC } from '../types.js';
import { buildCallExample, buildExampleArgs, callLine, shellQuote } from '../codegen/example-args.js';
import { escapeControlChars, firstSentence } from '../search-index.js';
import { skillDirName } from '../server-name.js';

/**
 * `full` lists every tool with its description, a parameter table and a usage
 * line; `compact` lists one line per tool and leaves the detail to
 * `mcpkit describe`. `auto` picks compact for servers with many tools, where the
 * full format costs thousands of tokens every time the skill is loaded.
 */
export type SkillFormat = 'auto' | 'full' | 'compact';

/** Servers with more tools than this get the compact format under `auto`. */
export const COMPACT_TOOL_THRESHOLD = 15;

/** Longest summary per tool in the compact format. */
const COMPACT_SUMMARY_MAX = 140;

/** Section shared by both skill formats and by the mcpkit-cli meta-skill, word for word. */
export const SCRIPTING_BLOCK = [
  '## Scripting several calls',
  '',
  'If you have a code-execution tool (for example Claude Code with Code Mode), script the calls: each `mcpkit call <server> <tool> \'<json>\' --json` is an ordinary Bash call, so your permission rules and hooks still apply per call. Otherwise batch them with `mcpkit exec --allow-read-only script.js`: the script is the body of an async function and calls `mcp["<server>"].<tool>({...})`; `mcpkit types <server>` prints the typed API. Writes need `--allow <server>.<tool>`; `--allow-writes` allows everything.',
].join('\n');

/**
 * The line under the scripting block that says what `--allow-read-only` does on this server. It
 * allows only tools that declare `readOnlyHint: true`, and many servers declare none, so on them
 * the flag allows nothing and an agent that trusts the generic text wastes a run.
 */
function readOnlyLine(ctx: GeneratorContext): string {
  const total = ctx.tools.length;
  const declared = ctx.tools.filter((tool) => tool.annotations?.readOnlyHint === true).length;
  const allow = `--allow ${shellQuote(ctx.serverName)}.<tool>`;
  if (declared === 0) {
    return `This server declares no read-only hints, so --allow-read-only allows nothing here: allow tools one by one, for example ${allow}.`;
  }
  const covered = `${declared} of ${total} tools declare readOnlyHint (--allow-read-only covers only those)`;
  return declared === total ? `${covered}.` : `${covered}; allow the others with ${allow}.`;
}

/**
 * Where a server's skill goes: `<skillsRoot>/mcpkit-<serverName>/SKILL.md`. Every generator builds
 * its path here. The name is validated first and the result is checked to lie directly inside
 * `skillsRoot` (compared as resolved paths, symlinks left alone: a skills directory that is a link
 * into a dotfiles repo is legitimate), so no name can place a skill, or the recursive delete that
 * removes it, anywhere else. Throws for a name that fails the rule.
 */
export function skillFilePath(skillsRoot: string, serverName: string): string {
  const dir = skillDirName(serverName);
  const root = resolve(skillsRoot);
  const filePath = join(root, dir, 'SKILL.md');
  const inside = relative(root, filePath);
  if (inside !== join(dir, 'SKILL.md') || isAbsolute(inside)) {
    throw new Error(`Refusing to place the skill of ${JSON.stringify(serverName)} outside ${root}.`);
  }
  return filePath;
}

// Build a markdown table from JSON Schema properties
export function buildParamTable(schema: Record<string, unknown>): string {
  const props = (schema.properties || {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required || []) as string[];
  if (Object.keys(props).length === 0) return '_No parameters_';

  const rows = Object.entries(props).map(([name, prop]) => {
    const type = (prop.type as string) || 'any';
    const req = required.includes(name) ? 'Yes' : 'No';
    const desc = (prop.description as string) || '';
    return `| \`${escapeControlChars(name)}\` | ${type} | ${req} | ${desc} |`;
  });

  return ['| Param | Type | Required | Description |', '|-------|------|----------|-------------|', ...rows].join('\n');
}

// Build mcpkit call command string
export function buildCallCommand(serverName: string, toolName: string): string {
  return callLine(serverName, toolName, '{}');
}

/**
 * Group tools by their name prefix (the segment before the first _ or -).
 * Returns prefixes sorted by tool count, descending. e.g. for a server with
 * e2e_*, create_*, deploy_* tools → [['e2e', 40], ['create', 8], ...].
 */
function domainCounts(tools: ToolInfo[]): Array<[string, number]> {
  const counts: Record<string, number> = {};
  for (const tool of tools) {
    const prefix = escapeControlChars(tool.name).split(/[_-]/)[0];
    if (prefix) counts[prefix] = (counts[prefix] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

/**
 * Infer the primary domain from tool name prefixes.
 * e.g., tools named browser_navigate, browser_click → "browser"
 */
function inferDomain(tools: ToolInfo[]): string {
  const sorted = domainCounts(tools);
  // Use dominant prefix if it covers >40% of tools
  if (sorted.length > 0 && sorted[0][1] > tools.length * 0.4) {
    return sorted[0][0];
  }
  return '';
}

/**
 * For multi-domain servers (no single dominant prefix), list the top few
 * prefixes so the routing description signals breadth. Returns a phrase like
 * "e2e, create, deploy" or '' if there aren't multiple meaningful groups.
 */
function topDomains(tools: ToolInfo[], max = 5): string {
  const sorted = domainCounts(tools).filter(([, n]) => n >= 2);
  if (sorted.length < 2) return '';
  return sorted.slice(0, max).map(([p]) => p).join(', ');
}

/**
 * Extract the core action from a tool description (first clause, lowercased).
 */
function coreAction(desc: string): string {
  const lower = desc.toLowerCase();
  const match = lower.match(/^([^.;!]+?)(?:\.|;|$)/);
  return (match ? match[1] : lower).trim().replace(/\.$/, '');
}

/**
 * Build a short capability summary from tool descriptions.
 *
 * Samples evenly across the whole tool list (not just the first N, which for a
 * large alphabetically-ordered server would only surface one corner of it), so
 * the summary reflects the server's full breadth. Item count scales with the
 * number of tools.
 */
function buildCapabilitySummary(tools: ToolInfo[]): string {
  const withDesc = tools.filter(t => t.description);
  if (withDesc.length === 0) return '';

  // Scale how many phrases we surface with the tool count.
  const maxItems = withDesc.length > 60 ? 12 : withDesc.length > 20 ? 9 : 6;

  // Stride-sample across the full list so we don't bias to alphabetical head.
  const stride = Math.max(1, Math.floor(withDesc.length / (maxItems * 2)));
  const sampled: ToolInfo[] = [];
  for (let i = 0; i < withDesc.length && sampled.length < maxItems * 2; i += stride) {
    sampled.push(withDesc[i]);
  }

  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const t of sampled) {
    const action = coreAction(t.description);
    // Skip near-duplicates and overlong clauses (poor routing signal).
    if (!action || action.length > 60 || seen.has(action)) continue;
    seen.add(action);
    phrases.push(action);
    if (phrases.length >= maxItems) break;
  }

  return phrases.join(', ');
}

/**
 * Build the frontmatter description — the critical line agents see in skill listings.
 *
 * Priority:
 *   1. User-provided description (--description flag)
 *   2. MCP server instructions (from initialize response)
 *   3. npm package description (for npx-based servers)
 *   4. Auto-generated from tool descriptions
 *
 * The generated forms (2-4) lean on what the server calls itself, which can be
 * unrelated to the name it is registered under, and agents route by the
 * registered name. When that name is missing the description says it after
 * "via mcpkit", e.g. "Demo tools via mcpkit (mailmodo) — ...".
 */
function buildFrontmatterDescription(ctx: GeneratorContext): string {
  // 1. User-provided description takes priority
  if (ctx.description) {
    return ctx.description;
  }

  const plain = clampDescription(autoDescription(ctx, ''));
  if (mentionsName(plain, ctx.serverName)) return plain;

  const tagged = clampDescription(autoDescription(ctx, ` (${ctx.serverName})`));
  if (mentionsName(tagged, ctx.serverName)) return tagged;

  // A lead long enough to push the tag past the length limit (a verbose package
  // description): lead with the name instead.
  return clampDescription(`${ctx.serverName}: ${plain}`);
}

/** Priorities 2-4 of the description; `tag` follows "via mcpkit" and is empty when the name needs no help. */
function autoDescription(ctx: GeneratorContext, tag: string): string {
  const serverName = ctx.serverMeta?.name || ctx.serverName;
  const domain = inferDomain(ctx.tools) || serverName;
  const capabilities = buildCapabilitySummary(ctx.tools);
  const domains = topDomains(ctx.tools);
  const via = `via mcpkit${tag}`;

  // A "work with" clause that reflects breadth: for multi-domain servers list
  // the top prefixes so the router matches more intents; else the single domain.
  const worksWith = domains
    ? `Use this for tasks involving ${domains}.`
    : `Use this when you need to work with ${domain}.`;

  // Proxy/bridge packages (mcp-remote, supergateway, etc.) describe the transport
  // shim, NOT the tools behind it — useless for routing. Detect and lead with the
  // tool-derived signal instead.
  const isProxyPackage = ctx.serverMeta?.packageDescription
    ? /\b(proxy|bridge|gateway|remote proxy|stdio.*http|http.*stdio)\b/i.test(ctx.serverMeta.packageDescription)
    : false;

  // 2. MCP server instructions
  if (ctx.serverMeta?.instructions) {
    const instructions = ctx.serverMeta.instructions.replace(/\n/g, ' ').trim();
    return `${serverName} ${via} — ${instructions}`;
  }

  // 3. npm package description — enrich with capabilities + domain breadth.
  //    Skipped for proxy/bridge packages (their description describes the shim).
  if (ctx.serverMeta?.packageDescription && !isProxyPackage) {
    const npmDesc = ctx.serverMeta.packageDescription;
    if (capabilities) {
      return `${npmDesc} ${via} — ${capabilities}. ${worksWith}`;
    }
    return `${npmDesc} ${via}. ${worksWith}`;
  }

  // 4. Auto-generated from tool metadata (also the path for proxy-fronted servers)
  if (capabilities) {
    return `${capitalize(domain)} tools ${via} — ${capabilities}. ${worksWith}`;
  }

  return `${capitalize(domain)} tools ${via}. ${worksWith}`;
}

/**
 * Whether the registered server name appears in the description as a name of its
 * own: case-insensitive and not just a fragment of a longer word ("git" is not in
 * "digital"; "reddit" is in "reddit-mcp-buddy").
 */
function mentionsName(description: string, registered: string): boolean {
  const name = registered.replace(/\s+/g, ' ').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${name}(?![\\p{L}\\p{N}])`, 'iu').test(description);
}

/**
 * Keep the routing description to a sane length. Skill listings truncate long
 * descriptions; an over-long line wastes the budget and buries the routing
 * signal. Trims at a clause boundary near the cap.
 */
function clampDescription(desc: string, max = 400): string {
  const flat = desc.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const head = flat.slice(0, max);
  const lastBreak = Math.max(head.lastIndexOf('. '), head.lastIndexOf(', '));
  return (lastBreak > max * 0.6 ? head.slice(0, lastBreak) : head.trimEnd()) + '…';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The arguments of an example call as JSON: the placeholders of the shared builder
 * (`buildExampleArgs`, which honours bounds, enums, `const`, `minItems` and the
 * combinators), written `"key": value` per required parameter. `{}` when none is required.
 */
function buildExampleParams(inputSchema: unknown): string {
  const entries = Object.entries(buildExampleArgs(inputSchema))
    .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return entries.length > 0 ? `{${entries.join(', ')}}` : '{}';
}

/**
 * The tool whose call is printed as the skill's "Example:". An agent copies that
 * line, so a tool the server marks read-only wins over an earlier one that
 * mutates; with no such tool the first one qualifies, as before. Only tools with
 * required parameters qualify, because the example shows how to fill them. The
 * hint is server-declared: it steers the choice and guarantees nothing.
 */
function pickExampleTool(tools: ToolInfo[]): ToolInfo | undefined {
  const withRequired = tools.filter((tool) => {
    const required = tool.inputSchema.required;
    return Array.isArray(required) && required.length > 0;
  });
  return withRequired.find((tool) => tool.annotations?.readOnlyHint === true) ?? withRequired[0];
}

function formatTimeout(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/**
 * A YAML double-quoted scalar. JSON string syntax is valid YAML, so a quote,
 * backslash or newline in the description cannot break the frontmatter. The
 * C1 controls and the Unicode line separators JSON leaves raw are escaped too,
 * because YAML rejects some of them and treats others as line breaks.
 */
function yamlQuote(text: string): string {
  return JSON.stringify(text).replace(/[\u007f-\u009f\u2028\u2029]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * The `name:` value of a skill: `mcpkit-<server>`, written bare when it only has
 * letters, digits, dots, underscores and hyphens and quoted otherwise, so an
 * odd server name can neither add frontmatter lines nor change what it parses to.
 */
function skillName(server: string): string {
  const name = `mcpkit-${server}`;
  return /^[\p{L}\p{N}._-]+$/u.test(name) ? name : yamlQuote(name);
}

function buildFullSkillContent(ctx: GeneratorContext): string {
  const description = buildFrontmatterDescription(ctx);
  const serverName = escapeControlChars(ctx.serverMeta?.name || ctx.serverName);
  const server = escapeControlChars(ctx.serverName);
  const serverWord = shellQuote(ctx.serverName);
  const domain = inferDomain(ctx.tools) || serverName;
  const isStdio = ctx.transport.type === 'stdio';
  const isPersistentEnabled = ctx.runtime?.mode === 'persistent';

  const lines: string[] = [
    '---',
    `name: ${skillName(ctx.serverName)}`,
    `description: ${yamlQuote(description)}`,
    '---',
    '',
    `# ${serverName} (MCP Server)`,
    '',
    ctx.description || ctx.serverMeta?.instructions || ctx.serverMeta?.packageDescription || `${capitalize(domain)} tools installed via mcpkit.`,
    '',
    `> **Important:** These are NOT native MCP tools. Do NOT call them as \`mcp__${server}__*\` tools.`,
    `> All tools must be invoked via Bash using \`mcpkit call ${serverWord} <tool_name> '<json_params>'\`.`,
    '',
    '## When to Use',
    '',
    `Use this skill when you need to:`,
  ];

  // Build "When to use" bullets from tool descriptions
  for (const tool of ctx.tools) {
    if (tool.description) {
      lines.push(`- ${tool.description}`);
    }
  }
  lines.push('');

  // --- How to Use section ---
  lines.push('## How to Use mcpkit');
  lines.push('');

  // Basic call syntax with a concrete example
  lines.push('### Calling a tool');
  lines.push('');
  lines.push('```bash');
  lines.push(`mcpkit call ${serverWord} <tool_name> '<json_params>'`);
  lines.push('```');
  lines.push('');

  const exampleTool = pickExampleTool(ctx.tools);
  if (exampleTool) {
    const exParams = buildExampleParams(exampleTool.inputSchema);
    lines.push('Example:');
    lines.push('```bash');
    lines.push(callLine(ctx.serverName, exampleTool.name, exParams));
    lines.push('```');
    lines.push('');
  }

  lines.push('Output is plain text or JSON depending on the tool. Parse JSON output with `jq` if needed.');
  lines.push('');

  // Chaining
  lines.push('### Chaining multiple calls');
  lines.push('');
  lines.push('Run dependent tool calls in one session using `--chain`. Reference previous output with `$prev.fieldName` (JSON output) or `$prev._text` (plain text):');
  lines.push('');
  lines.push('```bash');
  lines.push(`mcpkit call ${serverWord} <tool_a> '{}' --chain '<tool_b>:{"input":"$prev.someField"}'`);
  lines.push('```');
  lines.push('');

  // Param provider info
  if (ctx.paramProvider) {
    lines.push('### Auto-injected parameters');
    lines.push('');
    lines.push(`This server has a param provider configured (\`${ctx.paramProvider.command}\`) that automatically injects parameters (e.g., auth credentials) into every tool call. You do **not** need to pass these params manually.`);
    lines.push('');
  }

  // Persistent runtime section — context-aware
  if (isStdio) {
    if (isPersistentEnabled) {
      const idle = ctx.runtime?.idleTimeoutSec ?? DEFAULT_RUNTIME_IDLE_TIMEOUT_SEC;
      const call = ctx.runtime?.callTimeoutSec ?? DEFAULT_RUNTIME_CALL_TIMEOUT_SEC;
      lines.push('### Persistent runtime (enabled)');
      lines.push('');
      lines.push(`This server runs as a **persistent background daemon**. The MCP server process stays alive between tool calls, so:`);
      lines.push('- No reconnect overhead on each call');
      lines.push('- Session state (browser windows, in-memory data, etc.) persists across calls');
      lines.push(`- The daemon auto-starts on first \`mcpkit call\` — no manual startup needed`);
      lines.push(`- Idle timeout: **${formatTimeout(idle)}** — daemon shuts down after ${formatTimeout(idle)} of inactivity`);
      lines.push(`- Call timeout: **${formatTimeout(call)}** — maximum time for a single tool call`);
      lines.push('');
      lines.push('Manage the runtime:');
      lines.push('```bash');
      lines.push(`mcpkit runtime status ${serverWord}   # Check if daemon is running`);
      lines.push(`mcpkit runtime stop ${serverWord}     # Stop the daemon`);
      lines.push('```');
      lines.push('');
      lines.push('Change timeout settings:');
      lines.push('```bash');
      lines.push(`mcpkit edit ${serverWord} --runtime-idle-timeout <seconds> --runtime-call-timeout <seconds>`);
      lines.push('```');
    } else {
      lines.push('### Persistent runtime (available)');
      lines.push('');
      lines.push('This server uses stdio transport and supports persistent runtimes. When enabled, the MCP server process stays alive between calls — useful for servers that maintain session state (browsers, databases, etc.).');
      lines.push('');
      lines.push('Enable persistent runtime:');
      lines.push('```bash');
      lines.push(`mcpkit edit ${serverWord} --runtime persistent --runtime-idle-timeout 900 --runtime-call-timeout 3600`);
      lines.push('```');
    }
    lines.push('');

    // Keepalive flag
    lines.push('### Keep-alive sessions');
    lines.push('');
    lines.push('Use `--keepalive` to hold a stdio session open after a call (useful for interactive exploration):');
    lines.push('```bash');
    lines.push(`mcpkit call ${serverWord} <tool_name> '{}' --keepalive`);
    lines.push('```');
    lines.push('');
  }

  // Discovery commands
  lines.push('### Discovery');
  lines.push('');
  lines.push('```bash');
  lines.push(`mcpkit list ${serverWord}   # List available tools on this server`);
  lines.push(`mcpkit view ${serverWord}   # Show server config: transport, runtime mode, param provider, timeouts`);
  lines.push('```');
  lines.push('');

  lines.push(SCRIPTING_BLOCK);
  lines.push('');
  lines.push(readOnlyLine(ctx));
  lines.push('');

  // --- Tools section ---
  lines.push('## Tools');
  lines.push('');

  for (const tool of ctx.tools) {
    lines.push(`### ${escapeControlChars(tool.name)}`);
    lines.push('');
    if (tool.description) lines.push(tool.description);
    lines.push('');
    lines.push('**Parameters:**');
    lines.push('');
    lines.push(buildParamTable(tool.inputSchema as Record<string, unknown>));
    lines.push('');
    lines.push('**Usage:**');
    lines.push('```bash');
    lines.push(callLine(ctx.serverName, tool.name, buildExampleParams(tool.inputSchema)));
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

function introText(ctx: GeneratorContext, domain: string): string {
  if (ctx.description) return ctx.description;
  const meta = ctx.serverMeta?.instructions || ctx.serverMeta?.packageDescription;
  return meta ? clampDescription(meta, 600) : `${capitalize(domain)} tools installed via mcpkit.`;
}

/**
 * The compact SKILL.md: routing frontmatter, how to call, how to discover and
 * script, then one line per tool. Parameters and long descriptions are left to
 * `mcpkit describe`, so the file stays small however many tools the server has.
 */
function buildCompactSkillContent(ctx: GeneratorContext): string {
  const serverName = escapeControlChars(ctx.serverMeta?.name || ctx.serverName);
  const domain = inferDomain(ctx.tools) || serverName;
  const server = escapeControlChars(ctx.serverName);
  const serverWord = shellQuote(ctx.serverName);

  const lines: string[] = [
    '---',
    `name: ${skillName(ctx.serverName)}`,
    `description: ${yamlQuote(buildFrontmatterDescription(ctx))}`,
    '---',
    '',
    `# ${serverName} (MCP Server)`,
    '',
    introText(ctx, domain),
    '',
    `> **Important:** These are NOT native MCP tools. Do NOT call them as \`mcp__${server}__*\` tools.`,
    `> All tools must be invoked via Bash using \`mcpkit call ${serverWord} <tool_name> '<json_params>'\`.`,
    '',
    '## How to Call',
    '',
    '```bash',
    `mcpkit call ${serverWord} <tool_name> '<json_params>'`,
    '```',
    '',
  ];

  const exampleTool = pickExampleTool(ctx.tools);
  if (exampleTool) {
    lines.push('Example:', '```bash', buildCallExample(ctx.serverName, exampleTool.name, exampleTool.inputSchema), '```', '');
  }
  lines.push('Add `--json` for machine-readable output. A failed tool call prints its error on stderr and exits 1.', '');

  lines.push(
    '## Discover',
    '',
    '```bash',
    `mcpkit search <keywords> --server ${serverWord}   # rank this server's tools by keyword`,
    `mcpkit describe ${serverWord} <tool_name>   # full description, JSON Schema, ready example call`,
    `mcpkit types ${serverWord}   # TypeScript declarations for every tool`,
    '```',
    '',
  );

  lines.push(SCRIPTING_BLOCK, '', readOnlyLine(ctx), '');

  if (ctx.paramProvider) {
    lines.push(
      `Parameters from the param provider (\`${ctx.paramProvider.command}\`) are injected into every call automatically; do not pass them yourself.`,
      '',
    );
  }
  if (ctx.transport.type === 'stdio' && ctx.runtime?.mode === 'persistent') {
    lines.push(
      `This server runs as a persistent background daemon (idle timeout ${formatTimeout(ctx.runtime.idleTimeoutSec ?? DEFAULT_RUNTIME_IDLE_TIMEOUT_SEC)}, call timeout ${formatTimeout(ctx.runtime.callTimeoutSec ?? DEFAULT_RUNTIME_CALL_TIMEOUT_SEC)}): \`mcpkit runtime status ${serverWord}\`, \`mcpkit runtime stop ${serverWord}\`.`,
      '',
    );
  }

  lines.push(
    `Not sure which tool you need? mcpkit search <words> --server ${serverWord} ranks this server's tools (the list below is only names).`,
    '',
    `## Tools (${ctx.tools.length})`,
    '',
  );
  for (const tool of ctx.tools) {
    const summary = firstSentence(tool.description, COMPACT_SUMMARY_MAX);
    const name = escapeControlChars(tool.name);
    lines.push(summary ? `- \`${name}\` - ${summary}` : `- \`${name}\``);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Build standard agentskills.io SKILL.md content.
 * Shared across all generators since the format is the same.
 */
export function buildSkillContent(ctx: GeneratorContext, options: { format?: SkillFormat } = {}): string {
  const format = options.format ?? 'auto';
  const compact = format === 'compact' || (format === 'auto' && ctx.tools.length > COMPACT_TOOL_THRESHOLD);
  return compact ? buildCompactSkillContent(ctx) : buildFullSkillContent(ctx);
}

// Import generators lazily
export async function getGenerator(agent: AgentType): Promise<(ctx: GeneratorContext) => GeneratedSkill> {
  switch (agent) {
    case 'claude-code': return (await import('./claude-code.js')).generate;
    case 'cursor': return (await import('./cursor.js')).generate;
    case 'codex': return (await import('./codex.js')).generate;
    case 'windsurf': return (await import('./windsurf.js')).generate;
    case 'augment': return (await import('./augment.js')).generate;
    case 'openclaw': return (await import('./openclaw.js')).generate;
    case 'hermes': return (await import('./hermes.js')).generate;
  }
}

// Detect which agents are installed on the system
export function detectAgents(): AgentType[] {
  const agents: AgentType[] = [];
  const home = homedir();

  if (existsSync(join(home, '.claude'))) agents.push('claude-code');
  if (existsSync(join(process.cwd(), '.cursor')) || existsSync(join(home, '.cursor'))) agents.push('cursor');
  if (existsSync(join(home, '.codex')) || existsSync(join(home, '.agents'))) agents.push('codex');
  if (existsSync(join(process.cwd(), '.windsurf')) || existsSync(join(home, '.codeium'))) agents.push('windsurf');
  if (existsSync(join(home, '.augment')) || existsSync(join(process.cwd(), '.augment'))) agents.push('augment');
  if (existsSync(join(home, '.openclaw'))) agents.push('openclaw');
  if (existsSync(process.env.HERMES_HOME || join(home, '.hermes'))) agents.push('hermes');

  return agents;
}
