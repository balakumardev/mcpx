import { createHash } from 'node:crypto';
import { compareText } from './search-index.js';
import { buildSessionContext, neutralize, sameToolSetGroups, sanitizeUntrusted } from './session-context.js';
import type { DirectoryServer } from './session-context.js';

/**
 * The live server directory written into the `mcpkit-cli` guide skill of an agent that has no
 * session hook. It comes in two sizes: a short one-line `descriptionSuffix` for the guide's
 * always-loaded `description:` (the name of every server and what it does, in a few words) and a
 * `bodySection` with the full directory, the same text the SessionStart hook injects. An agent without
 * a hook (Cursor, Codex, Windsurf, Augment) routes on that suffix alone, so "use it for Gmail" has to
 * be answerable from it. Every piece of text about a server is sanitised (the descriptions come from
 * files a server or a user wrote), nothing else about a server is read, and the same input always
 * gives the same output, so the fingerprint can tell a guide that needs rewriting from one that does not.
 *
 * The short text of one server is made from its registry description (`parseDescription`): the e-mail
 * addresses, the URLs, "via mcpkit" and a leading self-name ("Composio MCP") are dropped, a leading
 * parenthetical qualifier such as `(WORK — x)` is taken out (for the servers of a twin group it
 * becomes the label that tells them apart), and what is left is cut to its first clause.
 */

export interface GuideDirectory {
  /** One line, no line breaks, to append to the guide's frontmatter description; empty when there are no servers. */
  descriptionSuffix: string;
  /** A Markdown section for the guide's body; empty when there are no servers. */
  bodySection: string;
  /** A short stable hash of both: equal output means an equal guide. */
  fingerprint: string;
}

export interface GuideDirectoryOptions {
  /** Target length of `descriptionSuffix`, in characters. */
  descriptionBudget?: number;
}

export const GUIDE_DIRECTORY_HEADING = '## MCP servers reachable through mcpkit (live list)';

/** Default target length of the description suffix. */
export const DEFAULT_DESCRIPTION_BUDGET = 540;

/**
 * The most the suffix may reach when the twin servers alone do not fit the budget (see `fitSuffix`).
 * The guide's own description is 414 characters and the limit that matters is 960, so this leaves
 * room under it for the description, one space and this suffix.
 */
export const DESCRIPTION_SUFFIX_HARD_MAX = 544;

/** Budget of the full directory in the body: the hook's own default. */
const BODY_BUDGET = 3000;
/**
 * How much of a registry description is read. What the short text is made from is at the start of a
 * description, and the cap keeps every step below cheap whatever a description holds.
 */
const DESCRIPTION_READ_MAX = 600;
/** Longest "what it does" text per entry; the shorter one of the others is tried when the default does not fit (a twin keeps its text until the budget is tight). */
const OTHER_MAX = 48;
const TWIN_MAX = 64;
const OTHER_SHORT_MAX = 28;
/** Longest text of a twin once the budget is tight. */
const TIGHT_TWIN_MAX = 24;
/** Longest discriminator label of a twin (`WORK`, `PERSONAL`). */
const LABEL_MAX = 24;

const SUFFIX_PREFIX = 'MCP tools behind mcpkit (use it for anything these servers cover): ';
const REFRESH_SENTENCE = 'mcpkit refreshes this list automatically; `mcpkit list` shows the live registry.';

/** A server as the suffix prints it: names and descriptions already sanitised. */
interface Item {
  name: string;
  /** What the server does, in one clause; empty when the description has nothing usable. */
  capability: string;
  /** What tells a twin apart from the others of its group (`WORK`); empty for every other server, and when nothing tells it apart. */
  label: string;
  /** Another server has the same tool set, so the label and the text are how the agent picks between them. */
  twin: boolean;
}

/** What `parseDescription` makes of one registry description. */
interface Parsed {
  /** The qualifier the description starts with, as the twin label (`WORK`); empty when it has none. */
  label: string;
  /** The first clause of what is left of the description; empty when nothing usable is left. */
  capability: string;
  /** The description as one flat line with the qualifier's words in it: the text twins are compared on. */
  flat: string;
}

const NOTHING: Parsed = { label: '', capability: '', flat: '' };

// Every pattern below is a bounded character run or a literal, with nothing nested that could backtrack
// without limit, and only ever runs over the first DESCRIPTION_READ_MAX characters of a description.
const EMAIL = /[^\s()[\]<>‹›{}@,;:"']{0,64}@[^\s()[\]<>‹›{}@,;"']{1,255}/gu;
/** `user_id=u123`: configuration of the server, not what it does. */
const KEY_VALUE = /\b[\w.-]{1,40}=[^\s,;()[\]]{0,100}/gu;
const URL_LIKE = /(?:\b(?:https?|ftp):\/\/|\bwww\.)[^\s()[\]<>‹›{}"']{1,300}/giu;
const VIA_MCPKIT = /\bvia\s+mcpkit\b/giu;
const SEPARATORS_AT_START = /^[\s\-–—:,.;|·•]+/u;
const MCP_WORDS_AT_START = /^\s*(?:mcp\b(?:\s+server\b)?|server\b)/iu;
const BRACKET_CHARS = /[()[\]{}]/gu;
/** A text with no letter or digit is no text. */
const HAS_CONTENT = /[\p{L}\p{N}]/u;
/** Words at the end of a cut that make it read as broken ("tasks and"). */
const DANGLING_WORDS = /\s+(?:and|or|for|the|of|to|with|in|on|a|an|by|from|as|at|via|but|that|which|into|than|is|are|per|&)$/u;
const TRAILING_PUNCTUATION = /[\s,;:\-–—/&.]+$/u;
/** Short forms whose full stop is not the end of a sentence. */
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'inc', 'ltd', 'approx', 'incl']);
const COMMON_WORD = /^[\p{L}\p{N}][\p{L}\p{N}'’-]*$/u;

/** A word compared without its case or the punctuation around it. */
function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

const squash = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/**
 * `text` cut to at most `max` characters at a word boundary where one is near (so a surrogate pair is
 * never split either), without a dangling joining word ("tasks and") or trailing punctuation.
 */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  let cut = text;
  if (chars.length > max) {
    const head = chars.slice(0, max).join('');
    const space = head.lastIndexOf(' ');
    // The head already ends on a whole word when the next character is a space or a comma.
    cut = /^[\s,;:]$/u.test(chars[max]) ? head : space >= max * 0.5 ? head.slice(0, space) : head;
  }
  for (let previous = ''; previous !== cut;) {
    previous = cut;
    cut = cut.replace(TRAILING_PUNCTUATION, '').replace(DANGLING_WORDS, '');
  }
  return cut.trim();
}

/** The names a description may open with: the server's own name, spelled out, and the first word of a name with dashes. */
function nameVariants(name: string): string[] {
  const parts = name.split(/[-_.]+/u).filter((part) => part !== '');
  const variants = new Set<string>([name, parts.join(' '), parts.join('')]);
  if (parts.length > 1 && Array.from(parts[0]).length >= 3) variants.add(parts[0]);
  return [...variants].filter((variant) => Array.from(variant).length >= 2).sort((a, b) => b.length - a.length);
}

/** `text` without a leading self-name, the `MCP` / `MCP server` after it, and the separators after that. */
function dropSelfName(text: string, name: string): string {
  let rest = text.replace(SEPARATORS_AT_START, '');
  for (const variant of nameVariants(name)) {
    if (rest.slice(0, variant.length).toLowerCase() !== variant.toLowerCase()) continue;
    // A name is a whole word: "Slackbot" is not "Slack" followed by something.
    if (HAS_CONTENT.test(rest.charAt(variant.length))) continue;
    rest = rest.slice(variant.length).replace(MCP_WORDS_AT_START, '').replace(SEPARATORS_AT_START, '');
    break;
  }
  return rest;
}

/** The index of the bracket that closes the one at `start`, or -1 when none does. */
function closingBracket(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (char === '(' || char === '[') depth++;
    else if ((char === ')' || char === ']') && --depth === 0) return index;
  }
  return -1;
}

/** The parenthetical `text` opens with and what follows it; undefined when it opens with anything else. */
function takeLeadingBracket(text: string): { inner: string; rest: string } | undefined {
  if (text[0] !== '(' && text[0] !== '[') return undefined;
  const end = closingBracket(text, 0);
  return end === -1 ? undefined : { inner: text.slice(1, end), rest: text.slice(end + 1) };
}

/** `text` without its bracketed parts and without any bracket character left over (an unmatched one). */
function dropBrackets(text: string): string {
  const closeOf = new Map<number, number>();
  const open: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '(' || char === '[') open.push(index);
    else if ((char === ')' || char === ']') && open.length > 0) closeOf.set(open.pop() as number, index);
  }
  let out = '';
  for (let index = 0; index < text.length; index++) {
    const end = closeOf.get(index);
    if (end !== undefined) {
      out += ' ';
      index = end;
    } else {
      out += text[index];
    }
  }
  return out.replace(BRACKET_CHARS, ' ');
}

/** The text before the first sentence or clause break that has anything in it; empty when there is none. */
function firstClause(text: string): string {
  let rest = text;
  while (rest !== '') {
    let at = -1;
    let length = 0;
    for (let index = 0; index < rest.length && at === -1; index++) {
      if (rest.startsWith('. ', index)) {
        const word = rest.slice(0, index).split(' ').pop() ?? '';
        if (!ABBREVIATIONS.has(word.toLowerCase())) [at, length] = [index, 2];
      } else if (rest.startsWith(' — ', index) || rest.startsWith(' – ', index)) {
        [at, length] = [index, 3];
      } else if (rest.startsWith('; ', index)) {
        [at, length] = [index, 2];
      }
    }
    const piece = (at === -1 ? rest : rest.slice(0, at)).trim();
    if (HAS_CONTENT.test(piece)) return piece;
    if (at === -1) return '';
    rest = rest.slice(at + length);
  }
  return '';
}

/** The label of a twin from its leading qualifier: `WORK` for `WORK — x`, `PERSONAL` for `PERSONAL Google account`. */
function labelFromQualifier(inner: string): string {
  const segment = inner.split(/ - |[—–,;:|]/u)[0];
  const words = segment.split(' ').filter((word) => word !== '');
  const isCaps = (word: string): boolean => /^[\p{Lu}\p{N}][\p{Lu}\p{N}._/-]*$/u.test(word) && /\p{Lu}/u.test(word);
  let taken: string[];
  if (words.length > 0 && isCaps(words[0])) {
    // A run of capitals is the label: `WORK`, `PERSONAL` (the words after it are about the account, not its name).
    const end = words.findIndex((word) => !isCaps(word));
    taken = end === -1 ? words : words.slice(0, end);
  } else {
    // Else the words up to the first one in lower case; two words when it is the first.
    const lower = words.findIndex((word) => /^\p{Ll}/u.test(word));
    taken = lower === -1 ? words : lower === 0 ? words.slice(0, 2) : words.slice(0, lower);
  }
  return clip(taken.join(' '), LABEL_MAX);
}

/** Text that goes into the suffix: sanitised once more (the same rules as everywhere), and with no bracket in it. */
const finish = (text: string): string => squash(sanitizeUntrusted(text).replace(BRACKET_CHARS, ' '));

/**
 * What the suffix says about one server, from its registry description (see the comment at the top).
 * Never throws and never reads more than `DESCRIPTION_READ_MAX` characters; a description with nothing
 * usable in it (empty, only punctuation, only an address, only the name of the server) gives nothing.
 */
function parseDescription(name: string, description: string | undefined): Parsed {
  // The first characters, with control characters, escape sequences and line breaks already gone.
  const head = neutralize((description ?? '').slice(0, DESCRIPTION_READ_MAX));
  if (head === '') return NOTHING;
  const clean = squash(
    head
      .replace(EMAIL, (match) => (match.endsWith('.') ? '. ' : ' '))
      .replace(URL_LIKE, (match) => (match.endsWith('.') ? '. ' : ' '))
      .replace(KEY_VALUE, ' ')
      .replace(/@/gu, ' ')
      .replace(VIA_MCPKIT, ' '),
  );
  const named = dropSelfName(clean, name);
  const leading = takeLeadingBracket(named);
  const body = leading === undefined ? named : leading.rest.replace(SEPARATORS_AT_START, '');

  const flat = finish(`${leading?.inner ?? ''} ${leading === undefined ? named : leading.rest}`);
  const label = leading === undefined ? '' : finish(labelFromQualifier(leading.inner));
  const withoutBrackets = squash(dropBrackets(body)).replace(/\s+([.,;:])/gu, '$1').replace(SEPARATORS_AT_START, '');
  const capability = clip(finish(firstClause(withoutBrackets).replace(/:\s+/gu, ', ')), Infinity);
  return HAS_CONTENT.test(capability) || HAS_CONTENT.test(label)
    ? { label: HAS_CONTENT.test(label) ? label : '', capability: HAS_CONTENT.test(capability) ? capability : '', flat }
    : NOTHING;
}

/** The distinct words of `text` that can tell servers apart: plain words, not identifiers or codes. */
function plainWords(text: string): Array<{ word: string; key: string }> {
  const seen = new Set<string>();
  const words: Array<{ word: string; key: string }> = [];
  for (const raw of text.split(' ')) {
    const key = normalizeWord(raw);
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (key === '' || seen.has(key) || !COMMON_WORD.test(word)) continue;
    seen.add(key);
    words.push({ word, key });
  }
  return words;
}

/** The words of `own` that no other member of the group has, first in its text and then in the whole description. */
function distinguishingLabel(own: Parsed, others: readonly Parsed[]): string {
  const theirs = new Set(others.flatMap((other) => plainWords(other.flat).map(({ key }) => key)));
  for (const source of [own.capability, own.flat]) {
    const words = plainWords(source).filter(({ key }) => !theirs.has(key)).slice(0, 3);
    if (words.length > 0) return clip(words.map(({ word }) => word).join(' '), LABEL_MAX);
  }
  return '';
}

/** The labels of the servers of one twin group: what their descriptions open with when that tells them apart, else the words only each has. */
function twinLabels(members: readonly Parsed[]): string[] {
  const given = members.map((member) => member.label);
  const distinct = given.every((label) => label !== '') && new Set(given.map((label) => label.toLowerCase())).size === given.length;
  if (distinct) return given;
  return members.map((member, index) => distinguishingLabel(member, members.filter((_, other) => other !== index)));
}

function toItems(servers: readonly DirectoryServer[]): Item[] {
  const sorted = [...servers]
    .map((server) => {
      const name = neutralize(server.name);
      return { name, parsed: parseDescription(name, server.description) };
    })
    .sort((a, b) => compareText(a.name, b.name));
  const parsedOf = new Map(sorted.map(({ name, parsed }) => [name, parsed]));

  const labelByName = new Map<string, string>();
  for (const group of sameToolSetGroups(servers).map((names) => names.map(neutralize))) {
    const labels = twinLabels(group.map((name) => parsedOf.get(name) ?? NOTHING));
    group.forEach((name, index) => labelByName.set(name, labels[index]));
  }
  return sorted.map(({ name, parsed }) => ({ name, capability: parsed.capability, label: labelByName.get(name) ?? '', twin: labelByName.has(name) }));
}

/** The suffix for these entries, folded servers standing for as `+N more`. */
const compose = (entries: readonly string[], folded: number): string =>
  `${SUFFIX_PREFIX}${[...entries, ...(folded === 0 ? [] : [`+${folded} more`])].join(', ')}`;

/** `name (label: text)`, `name (label)`, `name (text)` or the bare `name`: never an empty parenthesis. */
function entryOf(item: Item, max: number): string {
  const capability = clip(item.capability, max);
  const inner = item.label !== '' ? (capability === '' ? item.label : `${item.label}: ${capability}`) : capability;
  return inner === '' ? item.name : `${item.name} (${inner})`;
}

/** What is left of a twin when the budget is tight: its label, or else a few words. */
const tightEntryOf = (item: Item): string => (item.label !== '' ? `${item.name} (${item.label})` : entryOf(item, TIGHT_TWIN_MAX));

/**
 * The one-line suffix for `items`, at most `budget` characters where that is possible. Deterministic,
 * the first of these that fits wins:
 *   1. every server with its text cut to 48 characters (64 for a twin), then the others to 28;
 *   2. the servers that have no twin as bare names;
 *   3. those servers folded, the alphabetically last first, into `+N more`;
 *   4. the twins cut to their label and a few words, then to their label alone.
 * A server that shares its whole tool set with another is never folded: the agent picks between the
 * twins by their labels. Only when the twins alone pass `DESCRIPTION_SUFFIX_HARD_MAX` (a handful of
 * servers with very long names, which no real registry has) does the limit of the description win,
 * and the alphabetically last twins fold too.
 */
function fitSuffix(items: readonly Item[], budget: number): string {
  const sized = (twinMax: number, otherMax: number): string[] => items.map((item) => entryOf(item, item.twin ? twinMax : otherMax));
  const full = sized(TWIN_MAX, OTHER_MAX);
  const attempt1 = compose(full, 0);
  if (attempt1.length <= budget) return attempt1;
  const shorter = compose(sized(TWIN_MAX, OTHER_SHORT_MAX), 0);
  if (shorter.length <= budget) return shorter;

  const mixed = items.map((item, index) => (item.twin ? full[index] : item.name));
  const attempt2 = compose(mixed, 0);
  if (attempt2.length <= budget) return attempt2;

  const folded = new Set<number>();
  for (const index of items.map((_, i) => i).filter((i) => !items[i].twin).reverse()) {
    folded.add(index);
    const attempt = compose(mixed.filter((_, i) => !folded.has(i)), folded.size);
    if (attempt.length <= budget) return attempt;
  }

  // Every server without a twin is folded now. The twins stay, cut to a few words with their label, and then to the label alone.
  const hardMax = Math.max(budget, DESCRIPTION_SUFFIX_HARD_MAX);
  const twins = items.filter((item) => item.twin);
  const tights = [twins.map((item) => entryOf(item, TIGHT_TWIN_MAX)), twins.map(tightEntryOf)].map((entries) => compose(entries, folded.size));
  // Over the budget, the smallest of them (the label alone) is the answer, as long as it is under the hard maximum.
  const tight = tights.find((text) => text.length <= budget) ?? (tights[tights.length - 1].length <= hardMax ? tights[tights.length - 1] : undefined);
  if (tight !== undefined) return tight;

  const twinEntries = twins.map(tightEntryOf);
  for (let kept = twinEntries.length - 1; kept >= 0; kept--) {
    const attempt = compose(twinEntries.slice(0, kept), folded.size + twinEntries.length - kept);
    if (attempt.length <= hardMax) return attempt;
  }
  return compose([], items.length);
}

/**
 * The directory of `servers` (already filtered for the agent) in the two forms the guide skill needs.
 * No servers gives empty text: the guide then carries no directory at all.
 */
export function buildGuideDirectory(servers: readonly DirectoryServer[], opts: GuideDirectoryOptions = {}): GuideDirectory {
  if (servers.length === 0) {
    return { descriptionSuffix: '', bodySection: '', fingerprint: fingerprintOf('', '') };
  }
  const budget = opts.descriptionBudget !== undefined && Number.isFinite(opts.descriptionBudget)
    ? Math.max(Math.floor(opts.descriptionBudget), SUFFIX_PREFIX.length + 12)
    : DEFAULT_DESCRIPTION_BUDGET;
  const descriptionSuffix = fitSuffix(toItems(servers), budget);
  const bodySection = [GUIDE_DIRECTORY_HEADING, '', buildSessionContext(servers, BODY_BUDGET), '', REFRESH_SENTENCE].join('\n');
  return { descriptionSuffix, bodySection, fingerprint: fingerprintOf(descriptionSuffix, bodySection) };
}

function fingerprintOf(descriptionSuffix: string, bodySection: string): string {
  return createHash('sha1').update(descriptionSuffix).update('\u0000').update(bodySection).digest('hex').slice(0, 12);
}
