import type { ToolInfo } from './types.js';

/** A tool together with the server it lives on. */
export interface IndexedTool {
  server: string;
  tool: ToolInfo;
}

export interface SearchHit extends IndexedTool {
  score: number;
  /** Other servers that have this identical tool (same name, schema and description); empty when there are none. */
  alsoIn: string[];
}

/** Function words that say nothing about what a tool does. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'for', 'in', 'on', 'at', 'by', 'and', 'or', 'with', 'from', 'into', 'onto', 'about',
  'is', 'are', 'was', 'be', 'am', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
  'do', 'does', 'how', 'what', 'which', 'who', 'when', 'where', 'can', 'will', 'as', 'so', 'if', 'than', 'then',
]);

/**
 * The words of an identifier or a sentence, lowercased: split on anything that is not a letter or
 * digit, on camelCase boundaries (`createIssue`, `HTTPServer`) and between letters and digits (`sheet1`).
 */
function words(text: string): string[] {
  return text
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Lowercased, de-duplicated search words with the stop words dropped; empty when the query is only stop words. */
export function queryTokens(query: string): string[] {
  return [...new Set(words(query))].filter((word) => !STOP_WORDS.has(word));
}

/** Porter's "measure": how many vowel-then-consonant runs a word has. */
function measure(word: string): number {
  return (word.replace(/[^aeiouy]+/g, 'C').replace(/[aeiouy]+/g, 'V').match(/VC/g) ?? []).length;
}

/** Ends consonant, vowel, consonant (the last not w, x or y): `sav`, `writ`, `fil`. */
const endsConsonantVowelConsonant = (word: string): boolean => /[^aeiouy][aeiouy][^aeiouywxy]$/.test(word);

/**
 * A light stemmer, the same for queries and tool text, so word forms meet: plurals (`replies`, `boxes`,
 * `tasks`), `-ing` and `-ed` (`uploading`, `stopped`, `saved`) and a final `e` (`create` and `creating` are
 * both `creat`, `save` and `saving` both `save`). Words under four letters and numbers are left alone.
 */
export function stem(word: string): string {
  if (word.length < 4 || /^\p{N}+$/u.test(word)) return word;
  let w = word;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (/(?:ss|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);

  const suffix = /(?:ing|(?<!e)ed)$/.exec(w);
  if (suffix) {
    const root = w.slice(0, -suffix[0].length);
    if (root.length >= 3 && /[aeiouy]/.test(root)) {
      w = root;
      if (/([^aeiouyls])\1$/.test(w) && w.length > 3) w = w.slice(0, -1);
      else if (measure(w) === 1 && endsConsonantVowelConsonant(w)) w = `${w}e`;
    }
  }
  if (w.length >= 4 && w.endsWith('e')) {
    const bare = w.slice(0, -1);
    if (measure(bare) > 1 || (measure(bare) === 1 && !endsConsonantVowelConsonant(bare))) w = bare;
  }
  return w;
}

const stems = new Map<string, string>();

/** `stem` with a memory: the same few thousand words come up for every tool. */
function stemmed(word: string): string {
  let result = stems.get(word);
  if (result === undefined) {
    if (stems.size > 50_000) stems.clear();
    result = stem(word);
    stems.set(word, result);
  }
  return result;
}

const terms = (text: string): string[] => words(text).map(stemmed);

/** A tool or server name as one lowercase string of letters and digits: `Get_Task`, `get-task` and `get task` agree. */
function flat(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// Ranking constants, see searchTools().
const K1 = 1.2;
const B = 0.6;
/** Weight of a word in the name, the title, the description and the first sentence of the description. */
const FIELD_WEIGHTS = [3, 2, 1, 1];
/** Query words of this many letters also match the start of longer words; shorter ones match whole words only. */
const MIN_PREFIX_LENGTH = 3;
const PREFIX_WEIGHT = 0.5;
/** Extra credit for tools whose name is made of query words, up to this fraction of the score. */
const NAME_COVERAGE_BONUS = 0.5;

export interface SearchOptions {
  /** Show identical tools (same name, description and schema) on several servers once, with `alsoIn`. Default true. */
  collapse?: boolean;
}

type Counts = [name: number, title: number, description: number, summary: number];

interface Doc {
  /** The same tool on every server that has it, in server order; the first one is shown. */
  members: IndexedTool[];
  counts: Map<string, Counts>;
  lengths: Counts;
  nameTerms: Set<string>;
  flatNames: Set<string>;
  flatQualified: string[];
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `value` with the keys of every object in sorted order, so equal schemas written in a different key order agree. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareText(a, b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

/** Group the tools that are one tool on several servers: same name, description and input schema. */
function groupTwins(entries: IndexedTool[]): IndexedTool[][] {
  const sorted = [...entries].sort((a, b) => compareText(a.server, b.server) || compareText(a.tool.name, b.tool.name));
  const byDescription = new Map<string, IndexedTool[]>();
  for (const entry of sorted) {
    const key = `${entry.tool.name}\u0000${entry.tool.description}`;
    byDescription.set(key, [...(byDescription.get(key) ?? []), entry]);
  }
  const groups: IndexedTool[][] = [];
  for (const candidates of byDescription.values()) {
    if (candidates.length === 1) {
      groups.push(candidates);
      continue;
    }
    // Schemas written the same way compare as plain JSON text; only differently written ones need the key-sorted form.
    const byText = new Map<string, IndexedTool[]>();
    for (const entry of candidates) {
      const key = JSON.stringify(entry.tool.inputSchema) ?? 'null';
      byText.set(key, [...(byText.get(key) ?? []), entry]);
    }
    const bySchema = new Map<string, IndexedTool[]>();
    for (const [text, sameText] of byText) {
      const key = byText.size === 1 ? text : JSON.stringify(canonical(JSON.parse(text)));
      bySchema.set(key, [...(bySchema.get(key) ?? []), ...sameText]);
    }
    groups.push(...bySchema.values());
  }
  return groups;
}

function buildDoc(members: IndexedTool[]): Doc {
  const { tool } = members[0];
  const fields = [
    terms(tool.name),
    terms(tool.title ?? tool.annotations?.title ?? ''),
    terms(tool.description),
    terms(firstSentence(tool.description, 300)),
  ];
  const counts = new Map<string, Counts>();
  fields.forEach((fieldTerms, field) => {
    for (const term of fieldTerms) {
      const termCounts = counts.get(term) ?? [0, 0, 0, 0];
      termCounts[field]++;
      counts.set(term, termCounts);
    }
  });
  return {
    members,
    counts,
    lengths: fields.map((fieldTerms) => fieldTerms.length) as Counts,
    nameTerms: new Set(fields[0]),
    flatNames: new Set(members.map((member) => flat(member.tool.name))),
    flatQualified: members.map((member) => flat(`${member.server}.${member.tool.name}`)),
  };
}

/**
 * Rank tools for a query, best first.
 *
 * 1. A tool whose name equals the query ignoring case, `_`, `-`, spaces and dots (so `get task`, `getTask` and
 *    `server.get_task` all find `get_task`) comes before every other tool.
 * 2. The rest are scored BM25-style over four fields, with the words stemmed (`uploading` finds `upload`).
 *    A query word earns the inverse document frequency of the word it matches, so words found in most tools
 *    (get, list, tool) count for little and a rare word decides. A name word is worth 3, a title word 2,
 *    a description word 1 and a word of the description's first sentence 1 more. Query words of three letters
 *    or more also match the start of longer words at half weight; shorter ones match whole words only.
 *    Stop words are ignored, so a query made only of them matches nothing but a tool of that exact name.
 * 3. Ties break by server name, then tool name.
 *
 * With `collapse` (the default) the same tool on several servers is one hit, naming the other servers in `alsoIn`.
 */
export function searchTools(entries: IndexedTool[], query: string, limit: number, options: SearchOptions = {}): SearchHit[] {
  const docs = groupTwins(entries).map(buildDoc);
  const flatQuery = flat(query);

  const prefixable = new Map<string, boolean>();
  for (const token of queryTokens(query)) {
    const term = stemmed(token);
    prefixable.set(term, (prefixable.get(term) ?? false) || token.length >= MIN_PREFIX_LENGTH);
  }

  const documentFrequency = new Map<string, number>();
  for (const doc of docs) for (const term of doc.counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  const idf = (term: string): number => {
    const df = documentFrequency.get(term) ?? 0;
    return Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
  };

  // Average field length over the tools that have the field, so a title on a few tools is not measured against the many without.
  const averageLengths: Counts = [1, 1, 1, 1];
  averageLengths.forEach((_, field) => {
    const filled = docs.filter((doc) => doc.lengths[field] > 0);
    if (filled.length > 0) averageLengths[field] = filled.reduce((sum, doc) => sum + doc.lengths[field], 0) / filled.length;
  });

  // Per query word: the tool words it stands for, each with how strongly.
  const vocabulary = [...documentFrequency.keys()];
  const matches = [...prefixable].map(([term, prefix]) => {
    const found = documentFrequency.has(term) ? [{ term, weight: 1 }] : [];
    if (prefix) for (const word of vocabulary) if (word !== term && word.startsWith(term)) found.push({ term: word, weight: PREFIX_WEIGHT });
    return found;
  });

  const ranked: Array<{ doc: Doc; exact: boolean; score: number }> = [];
  for (const doc of docs) {
    const exact = flatQuery !== '' && (doc.flatNames.has(flatQuery) || doc.flatQualified.includes(flatQuery));
    let score = 0;
    let nameWords = 0;
    for (const candidates of matches) {
      let best = 0;
      let inName = false;
      for (const { term, weight } of candidates) {
        const counts = doc.counts.get(term);
        if (!counts) continue;
        let evidence = 0;
        counts.forEach((count, field) => {
          if (count > 0) evidence += FIELD_WEIGHTS[field] * count / (1 - B + B * doc.lengths[field] / averageLengths[field]);
        });
        const value = weight * idf(term) * ((K1 + 1) * evidence) / (K1 + evidence);
        if (value > best) {
          best = value;
          inName = counts[0] > 0 && weight === 1;
        }
      }
      score += best;
      if (inName) nameWords++;
    }
    if (score === 0 && !exact) continue;
    if (doc.nameTerms.size > 0) score *= 1 + NAME_COVERAGE_BONUS * nameWords / doc.nameTerms.size;
    ranked.push({ doc, exact, score: Math.round(score * 1e6) / 1e6 });
  }

  ranked.sort((a, b) =>
    Number(b.exact) - Number(a.exact)
    || b.score - a.score
    || compareText(a.doc.members[0].server, b.doc.members[0].server)
    || compareText(a.doc.members[0].tool.name, b.doc.members[0].tool.name));

  const hits: SearchHit[] = [];
  for (const { doc, score } of ranked) {
    // A `server.tool` query shows that server's copy of a tool several servers share.
    const asked = doc.flatQualified.indexOf(flatQuery);
    const members = asked > 0 ? [doc.members[asked], ...doc.members.filter((_, index) => index !== asked)] : doc.members;
    const rounded = Math.round(score * 100) / 100;
    if (options.collapse === false) hits.push(...members.map((member) => ({ ...member, score: rounded, alsoIn: [] })));
    else hits.push({ ...members[0], score: rounded, alsoIn: members.slice(1).map((member) => member.server) });
    if (hits.length >= limit) break;
  }
  return hits.slice(0, limit);
}

const CONTROL_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

const SHORT_ESCAPES: Record<string, string> = { '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' };

/**
 * `text` with every control character (line breaks, tabs, ESC, the C1 controls
 * and the Unicode line and paragraph separators) written as a JSON-style escape,
 * so a name from a server can never start a new line, a heading or a terminal
 * sequence in what mcpkit prints or writes. Anything else, quotes and backslashes
 * included, is left as it is, so ordinary names come out byte for byte the same.
 */
export function escapeControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, (char) =>
    SHORT_ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * `JSON.stringify(value)` as one line for any reader that splits lines the Unicode
 * way (Python's `splitlines()` does), and with no raw control character a terminal
 * could act on: DEL, the C1 controls (which include NEL) and the line and paragraph
 * separators, which JSON leaves raw, are written as `\uXXXX` escapes.
 * Every other control character is below U+0020, which JSON always escapes.
 */
export function jsonLine(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** A server a hit's tool lives on, with its registry description when it has one. */
export interface HitServer {
  server: string;
  description?: string;
}

/** Longest registry description printed next to a server in text output and in JSON. */
export const TEXT_DESCRIPTION_MAX = 60;
export const JSON_DESCRIPTION_MAX = 120;

/**
 * The first `max` characters of a registry description, white space collapsed to single
 * spaces; `undefined` when there is nothing to show. Cuts by character, so a surrogate pair
 * is never split, and does not escape: escape the result after cutting, or an escape
 * sequence could be cut in half.
 */
export function clipDescription(text: string | undefined, max: number): string | undefined {
  const flat = Array.from((text ?? '').replace(/\s+/g, ' ').trim()).slice(0, max).join('').trimEnd();
  return flat === '' ? undefined : flat;
}

/**
 * Every server that has the tool of `hit`, the server shown first and then `alsoIn` in order,
 * each with its registry description cut to `max` characters. The registry is read through
 * `registeredServer`, so a server named `constructor` has no inherited description.
 */
export function hitServers(hit: SearchHit, servers: Record<string, { description?: string } | undefined>, max: number): HitServer[] {
  return [hit.server, ...hit.alsoIn].map((server) => {
    const description = clipDescription(registeredServer(servers, server)?.description, max);
    return description === undefined ? { server } : { server, description };
  });
}

/**
 * The text lines for one search hit. A tool only one server has is one `server.tool - summary`
 * line. A tool several servers have must not look like the choice of whichever server sorts
 * first (two registrations of one MCP server can be a work and a personal account), so
 * the line starts with the tool, names every server equally, and a second line says what each
 * server is, from its registry description:
 *
 *     GMAIL_GET_PROFILE on work, personal - Get the profile of the account.
 *       same tool on 2 servers: work = Composio MCP (WORK ...; personal = (no description)
 */
export function formatHit(hit: SearchHit, servers: Record<string, { description?: string } | undefined>): string[] {
  const summary = firstSentence(hit.tool.description);
  const tool = escapeControlChars(hit.tool.name);
  if (hit.alsoIn.length === 0) {
    const name = `${escapeControlChars(hit.server)}.${tool}`;
    return [summary ? `${name} - ${summary}` : name];
  }
  const shared = hitServers(hit, servers, TEXT_DESCRIPTION_MAX);
  const names = shared.map(({ server }) => escapeControlChars(server));
  const described = shared.map(({ description }, index) =>
    `${names[index]} = ${description === undefined ? '(no description)' : escapeControlChars(description)}`);
  return [
    `${tool} on ${names.join(', ')}${summary ? ` - ${summary}` : ''}`,
    `  same tool on ${shared.length} servers: ${described.join('; ')}`,
  ];
}

/** Abbreviations whose trailing dot does not end a sentence. */
const ABBREVIATION_END = /\b(?:e\.g|i\.e|vs|cf)\.$/i;

/**
 * The first sentence of a description, on one line and at most `max` characters
 * (cut at a word boundary with an ellipsis), with control characters escaped.
 * Empty for an empty description.
 */
export function firstSentence(text: string, max = 140): string {
  const flat = escapeControlChars((text.trim().split(/\n\s*\n/)[0] ?? '').replace(/\s+/g, ' ').trim());

  let end = flat.length;
  const terminator = /[.!?](?=\s+[A-Z0-9"'`(\[]|\s*$)/g;
  for (let match = terminator.exec(flat); match; match = terminator.exec(flat)) {
    if (ABBREVIATION_END.test(flat.slice(0, match.index + 1))) continue;
    end = match.index + 1;
    break;
  }

  const sentence = flat.slice(0, end);
  if (sentence.length <= max) return sentence;
  const head = sentence.slice(0, max - 1);
  const space = head.lastIndexOf(' ');
  return `${(space > max * 0.6 ? head.slice(0, space) : head).trimEnd()}…`;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/** The `count` names closest to `target`: names containing it first, then by edit distance. */
export function nearestNames(target: string, candidates: string[], count = 5): string[] {
  const wanted = target.toLowerCase();
  return candidates
    .map((name) => {
      const lower = name.toLowerCase();
      const contains = lower.includes(wanted) || wanted.includes(lower);
      return { name, contains, distance: editDistance(wanted, lower) };
    })
    .sort((a, b) =>
      Number(b.contains) - Number(a.contains)
      || a.distance - b.distance
      || a.name.localeCompare(b.name))
    .slice(0, count)
    .map((entry) => entry.name);
}

/**
 * The entry registered under `name`, looking at the registry's own keys only:
 * `constructor`, `toString` or `__proto__` are inherited, not servers.
 */
export function registeredServer<T>(servers: Record<string, T>, name: string): T | undefined {
  return Object.hasOwn(servers, name) ? servers[name] : undefined;
}

/** The error for a server name the registry does not know, with the closest registered names. */
export function unknownServerMessage(name: string, registered: string[]): string {
  const shown = escapeControlChars(name);
  if (registered.length === 0) return `Server "${shown}" not found: no servers are registered. Run \`mcpkit install <server>\` to add one.`;
  return `Server "${shown}" not found. Nearest: ${nearestNames(name, registered).map(escapeControlChars).join(', ')}. Run \`mcpkit list\` to see all registered servers.`;
}
