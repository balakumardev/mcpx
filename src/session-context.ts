import { clipDescription, compareText, groupTwins } from './search-index.js';
import type { IndexedTool } from './search-index.js';
import type { ToolInfo } from './types.js';

/**
 * The text a SessionStart hook injects: a short, always-current directory of the registered servers
 * and the five-line workflow for using them. Everything about a server here comes from files a
 * server or a user wrote (the registry description, the cached tool names), and the text goes
 * into every session, so each such piece is sanitised first and nothing else about a server
 * (no transport, command, URL, header or environment value) is ever read into it.
 */

/** Target size of the text; `--max-chars` overrides it. */
export const DEFAULT_MAX_CHARS = 3000;
/** The smallest budget accepted: a smaller one is raised to this. */
export const MIN_MAX_CHARS = 600;

/** Longest description shown per server: first at full length, then shortened by the budget algorithm. */
const DESCRIPTION_MAX = 140;
const SHORT_DESCRIPTION_MAX = 80;
/** Tool names listed for a server that has no registry description. */
const FALLBACK_TOOL_NAMES = 6;

/** What the directory needs to know about one registered server. */
export interface DirectoryServer {
  name: string;
  /** The registry description. */
  description?: string;
  /** The cached tools; undefined when the server has no usable schema cache (none yet, or unreadable, corrupt or of another version). */
  tools?: ToolInfo[];
}

export const WORKFLOW_LINES: readonly string[] = [
  'Find tools: mcpkit search <words> [--server <name>]. Schema: mcpkit describe <server> <tool>.',
  'Run: mcpkit exec --allow <server>.<tool> -c \'<js using mcp["<server>"].<tool>(args)>\' (many calls in one script; return only what you need).',
  'One call: mcpkit call <server> <tool> \'<json>\'.',
  'Writes are blocked unless allowed with --allow; --allow-read-only trusts only tools that declare readOnlyHint (a server declaring none allows nothing that way).',
  'Output shapes are often undeclared: first run one small exec that returns only Object.keys(result) or JSON.stringify(result).slice(0,300), then process the full result.',
];

// An ANSI escape sequence: OSC (ESC ] ... BEL or ESC \), CSI (ESC [ or U+009B, parameters, a final byte)
// or any other two-character ESC sequence. Removed whole, so the text of a sequence does not survive.
const ANSI_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b[@-_]/g;
// Format characters (zero-width, bidi overrides, tag characters), private use, lone surrogates and
// unassigned code points (U+FFFE, U+FFFF, U+FDD0 and the other noncharacters among them) are removed: they are
// invisible, and the last ones are not valid in a YAML document for a strict parser (PyYAML, Ruby).
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cs}\p{Cn}]/gu;
// Every other control character, the Unicode line and paragraph separators and all white space become one space.
const BREAKS_AND_SPACE = /[\p{Cc}\p{Zl}\p{Zp}\s]+/gu;

/**
 * An identifier or a sentence from an untrusted file as one safe line: ANSI escape sequences, control
 * characters, invisible and unassigned characters and line breaks (U+0085, U+2028 and U+2029 included) are gone (so a newline cannot start a heading or
 * a list item), and the characters that could close or open a wrapper tag or a code fence are
 * replaced with look-alikes: `<` `>` become `‹` `›` and a backtick becomes an apostrophe.
 */
export function neutralize(text: string): string {
  return text
    .replace(ANSI_SEQUENCE, '')
    .replace(INVISIBLE, '')
    .replace(BREAKS_AND_SPACE, ' ')
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/`/g, "'")
    .trim();
}

/**
 * `neutralize` for free text (a registry description): a run of three or more dashes, a Markdown rule
 * or the edge of a front-matter block, is cut to one. Names keep their dashes: a name is quoted back to
 * the agent in commands and must stay exactly what it is.
 */
export function sanitizeUntrusted(text: string): string {
  return neutralize(text).replace(/-{3,}/g, '-');
}

/**
 * The servers whose tool sets are identical, as groups of at least two names, each group and the list
 * sorted by name. A tool set is identical when every tool of one server has the same tool on the
 * other (same name, description and input schema: the rule `search` uses to collapse a tool shared
 * by several servers) and the other has no more. A server without cached tools matches nothing.
 */
export function sameToolSetGroups(servers: readonly DirectoryServer[]): string[][] {
  const entries: IndexedTool[] = servers.flatMap((server) => (server.tools ?? []).map((tool) => ({ server: server.name, tool })));
  const groupsOf = new Map<string, Set<number>>();
  groupTwins(entries).forEach((group, index) => {
    for (const { server } of group) groupsOf.set(server, (groupsOf.get(server) ?? new Set<number>()).add(index));
  });

  const bySignature = new Map<string, string[]>();
  for (const [server, groups] of groupsOf) {
    const signature = [...groups].sort((a, b) => a - b).join(',');
    bySignature.set(signature, [...(bySignature.get(signature) ?? []), server]);
  }
  return [...bySignature.values()]
    .filter((names) => names.length > 1)
    .map((names) => names.sort(compareText))
    .sort((a, b) => compareText(a[0], b[0]));
}

/** A server as it is printed: every piece of text already sanitised. */
interface Row {
  name: string;
  description: string;
  /** Whether the server has a usable schema cache; the rest of the fields come from it. */
  cached: boolean;
  toolNames: string[];
  toolCount: number;
  /** Tools declaring readOnlyHint true. */
  readOnly: number;
}

function toRow(server: DirectoryServer): Row {
  const tools = server.tools ?? [];
  return {
    name: neutralize(server.name),
    description: sanitizeUntrusted(server.description ?? ''),
    cached: server.tools !== undefined,
    toolNames: tools.slice(0, FALLBACK_TOOL_NAMES).map((tool) => neutralize(tool.name)),
    toolCount: tools.length,
    readOnly: tools.filter((tool) => tool.annotations?.readOnlyHint === true).length,
  };
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

interface Shape {
  /** Longest text after the colon. */
  descriptionMax: number;
  /** Whether the `(N tools, K read-only)` detail is printed. */
  detail: boolean;
}

function serverLine(row: Row, shape: Shape): string {
  if (!row.cached) {
    // Whatever the reason (never discovered, unreadable, corrupt, another version), the server stays listed.
    const description = clipDescription(row.description, shape.descriptionMax);
    return `- ${row.name}: ${description === undefined ? '' : `${description} `}(not cached; run mcpkit update ${row.name})`;
  }
  const detail = shape.detail ? ` (${plural(row.toolCount, 'tool')}, ${row.readOnly} read-only)` : '';
  const tail = row.description !== ''
    ? clipDescription(row.description, shape.descriptionMax)
    : clipDescription(`tools: ${row.toolNames.length === 0 ? '(none)' : row.toolNames.join(', ')}`, shape.descriptionMax);
  return `- ${row.name}${detail}: ${tail ?? ''}`;
}

/**
 * The directory text for `servers` (already filtered for the agent), at most `maxChars` characters
 * where that is possible. The header and the five workflow lines are never dropped.
 *
 * Budget algorithm, deterministic, applied until the text fits:
 *   (a) every description (or tool-name list) is cut to 80 characters;
 *   (b) the `(N tools, K read-only)` detail is dropped;
 *   (c) the alphabetically LAST servers are folded, one more at a time, into one line
 *       `+<n> more: <names>; run mcpkit list`; if even that cannot fit, the line drops the names.
 * A server that shares its whole tool set with another is never folded: the line "Same tool set on
 * ..." sends the agent to the descriptions to choose between them, so they must stay on show.
 *
 * A budget below MIN_MAX_CHARS is raised to it. The fixed text alone is close to that size, so
 * a budget at the floor can still be exceeded by the header, the workflow, the twin servers and the
 * fold line: they are the smallest output there is.
 */
export function buildSessionContext(servers: readonly DirectoryServer[], maxChars: number = DEFAULT_MAX_CHARS): string {
  if (servers.length === 0) return '';
  const budget = Math.max(Number.isFinite(maxChars) ? Math.floor(maxChars) : DEFAULT_MAX_CHARS, MIN_MAX_CHARS);

  const sorted = [...servers].sort((a, b) => compareText(neutralize(a.name), neutralize(b.name)));
  const rows = sorted.map(toRow);
  const twinGroups = sameToolSetGroups(servers).map((group) => group.map(neutralize));
  const twins = new Set(twinGroups.flat());
  const twinLines = twinGroups.map((group) => `Same tool set on ${group.join(', ')}: pick by the account in the descriptions above.`);

  const header = servers.length === 1
    ? 'mcpkit: 1 MCP server is available through the mcpkit CLI (run it with Bash). Use it for anything this server covers; otherwise do not.'
    : `mcpkit: ${servers.length} MCP servers are available through the mcpkit CLI (run it with Bash). Use it for anything these servers cover; otherwise do not.`;

  /** The whole text, without the rows in `folded` (by row index) and with `foldLine` standing for them. */
  const render = (shape: Shape, folded: ReadonlySet<number>, foldLine?: string): string => {
    const lines = rows.flatMap((row, index) => (folded.has(index) ? [] : [serverLine(row, shape)]));
    return [header, [...lines, ...(foldLine === undefined ? [] : [foldLine]), ...twinLines].join('\n'), WORKFLOW_LINES.join('\n')].join('\n\n');
  };

  const shapes: Shape[] = [
    { descriptionMax: DESCRIPTION_MAX, detail: true },
    { descriptionMax: SHORT_DESCRIPTION_MAX, detail: true },
    { descriptionMax: SHORT_DESCRIPTION_MAX, detail: false },
  ];
  const none: ReadonlySet<number> = new Set();
  for (const shape of shapes) {
    const text = render(shape, none);
    if (text.length <= budget) return text;
  }

  const lastShape = shapes[shapes.length - 1];
  const foldable = rows.map((_, index) => index).filter((index) => !twins.has(rows[index].name)).reverse();
  const folded = new Set<number>();
  for (const index of foldable) {
    folded.add(index);
    const names = rows.filter((_, i) => folded.has(i)).map((row) => row.name);
    const text = render(lastShape, folded, `+${names.length} more: ${names.join(', ')}; run mcpkit list`);
    if (text.length <= budget) return text;
  }
  return render(lastShape, folded, folded.size === 0 ? undefined : `+${folded.size} more; run mcpkit list`);
}
