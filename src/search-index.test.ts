import { describe, expect, it } from 'vitest';
import { clipDescription, escapeControlChars, firstSentence, formatHit, hitServers, jsonLine, nearestNames, queryTokens, registeredServer, searchTools, stem, unknownServerMessage } from './search-index.js';
import type { IndexedTool, SearchHit } from './search-index.js';
import type { ToolInfo } from './types.js';

function tool(name: string, description = '', extra: Partial<ToolInfo> = {}): ToolInfo {
  return { name, description, inputSchema: { type: 'object' }, ...extra };
}

describe('queryTokens', () => {
  it('lowercases, splits on punctuation and camelCase, de-duplicates and drops stop words', () => {
    expect(queryTokens('Create an Issue, create-ISSUE')).toEqual(['create', 'issue']);
    expect(queryTokens('listIssues in the repo')).toEqual(['list', 'issues', 'repo']);
  });

  it('is empty for stop words only and for blank text', () => {
    // A query of only function words ("the", "to") used to match every description that contains them.
    expect(queryTokens('the')).toEqual([]);
    expect(queryTokens('to be or not')).toEqual(['not']);
    expect(queryTokens('   ')).toEqual([]);
  });
});

describe('stem', () => {
  const classes = [
    ['message', 'messages', 'messaging', 'messaged'],
    ['create', 'creates', 'created', 'creating'],
    ['upload', 'uploads', 'uploaded', 'uploading'],
    ['reply', 'replies'],
    ['copy', 'copies'],
    ['task', 'tasks'],
    ['save', 'saves', 'saved', 'saving'],
    ['note', 'notes'],
    ['file', 'files'],
    ['issue', 'issues'],
    ['stop', 'stops', 'stopped', 'stopping'],
    ['run', 'runs', 'running'],
    ['add', 'adds', 'added', 'adding'],
    ['query', 'queries'],
    ['box', 'boxes'],
    ['batch', 'batches'],
    ['class', 'classes'],
    ['email', 'emails', 'emailing', 'emailed'],
    ['browse', 'browses', 'browsing'],
  ];

  it.each(classes)('maps %s and its forms to one stem', (...forms) => {
    expect(new Set(forms.map(stem)).size, forms.map(stem).join(' ')).toBe(1);
  });

  it('leaves short words, numbers and words that only look inflected alone', () => {
    for (const word of ['get', 'set', 'id', 'ui', '2024', 'status', 'class', 'analysis', 'string', 'thing', 'speed']) {
      expect(stem(word), word).toBe(word);
    }
  });

  it('does not join different words', () => {
    expect(new Set([stem('note'), stem('not')]).size).toBe(2);
    expect(new Set([stem('page'), stem('pay')]).size).toBe(2);
  });
});

describe('searchTools ranking', () => {
  const names = (hits: Array<{ tool: ToolInfo }>): string[] => hits.map((hit) => hit.tool.name);

  const taskServer: IndexedTool[] = [
    'get_projects', 'get_project', 'get_project_tasks', 'get_task', 'get_tasks_due_today', 'create_task', 'update_task', 'complete_task',
  ].map((name) => ({ server: 'ticktick', tool: tool(name, `Get details about a specific task. ${name} Args: task_id: ID of the task`) }));

  it('omits tools that match nothing and applies the limit after sorting', () => {
    const entries: IndexedTool[] = [
      { server: 's', tool: tool('create_issue', 'Create an issue') },
      { server: 's', tool: tool('list_issues', 'List the issues of a repository') },
      { server: 's', tool: tool('files', 'Works on issue files') },
      { server: 's', tool: tool('delete_repo', 'Delete a repository') },
    ];
    expect(names(searchTools(entries, 'issue', 10))).toEqual(['create_issue', 'list_issues', 'files']);
    expect(names(searchTools(entries, 'issue', 2))).toEqual(['create_issue', 'list_issues']);
    expect(searchTools(entries, 'zzz', 10)).toEqual([]);
  });

  it('ranks tools matching more query words above tools matching one', () => {
    const hits = searchTools([
      { server: 's', tool: tool('create_user', 'Add a user') },
      { server: 's', tool: tool('create_issue', 'Open an issue') },
      { server: 's', tool: tool('list_things', 'Show things') },
    ], 'create issue', 5);
    expect(names(hits)).toEqual(['create_issue', 'create_user']);
  });

  it('still returns tools when the query word is in every tool, as in a small server', () => {
    const entries: IndexedTool[] = ['get_task', 'create_task', 'delete_task'].map((name) => ({ server: 's', tool: tool(name, 'Works on a task') }));
    expect(names(searchTools(entries, 'task', 5)).sort()).toEqual(['create_task', 'delete_task', 'get_task']);
  });

  it('puts an exact tool name first, however the case and separators are written', () => {
    for (const query of ['get_task', 'getTask', 'get-task', 'GET TASK', 'Get_Task', 'ticktick.get_task']) {
      expect(names(searchTools(taskServer, query, 3))[0], query).toBe('get_task');
    }
  });

  it('puts a short exact name above longer names on another server that only mention the word', () => {
    const hits = searchTools([
      { server: 'a-media', tool: tool('media_upload_large_file', 'Upload a file in chunks. Upload upload upload.') },
      { server: 'b-media', tool: tool('upload_image', 'Upload an image') },
      { server: 'c-cloud', tool: tool('upload', 'Upload media') },
    ], 'upload', 5);
    expect(hits.map((hit) => `${hit.server}.${hit.tool.name}`)[0]).toBe('c-cloud.upload');
  });

  it('keeps every tool with the exact name ahead of the rest, in server order', () => {
    const hits = searchTools([
      { server: 'zeta', tool: tool('drag', 'Drag an element', { inputSchema: { type: 'object', properties: { a: { type: 'string' } } } }) },
      { server: 'alpha', tool: tool('drag', 'Drag an element', { inputSchema: { type: 'object', properties: { b: { type: 'number' } } } }) },
      { server: 'alpha', tool: tool('drag_and_drop', 'Drag and drop. Drag drag drag.') },
    ], 'drag', 5);
    expect(hits.map((hit) => `${hit.server}.${hit.tool.name}`)).toEqual(['alpha.drag', 'zeta.drag', 'alpha.drag_and_drop']);
  });

  it('matches word forms: uploading finds upload, replies finds reply, created finds create', () => {
    expect(names(searchTools([{ server: 's', tool: tool('upload_file', 'Sends a file') }], 'uploading', 5))).toEqual(['upload_file']);
    expect(names(searchTools([{ server: 's', tool: tool('reply_to_thread', 'Answer') }], 'replies', 5))).toEqual(['reply_to_thread']);
    expect(names(searchTools([{ server: 's', tool: tool('create_chart', 'Make') }], 'created', 5))).toEqual(['create_chart']);
    expect(names(searchTools([{ server: 's', tool: tool('list_messages', 'Show') }], 'message', 5))).toEqual(['list_messages']);
  });

  it('returns nothing for stop words and for one or two letters that only occur inside words', () => {
    const entries: IndexedTool[] = [
      { server: 's', tool: tool('add_label_to_email', 'Add a label to an email, or to a thread') },
      { server: 's', tool: tool('create_table', 'Create a table in a document') },
    ];
    for (const query of ['a', 'to', 'the', 'of the', 'ab', 'x']) expect(searchTools(entries, query, 5), query).toEqual([]);
  });

  it('still matches short words that are whole words of a name', () => {
    const entries: IndexedTool[] = [
      { server: 's', tool: tool('snapshot_ui', 'Describe the screen') },
      { server: 's', tool: tool('build_device', 'Build for a device, with a UI') },
    ];
    expect(names(searchTools(entries, 'ui', 5))).toEqual(['snapshot_ui', 'build_device']);
  });

  it('lets a rare word outweigh a word that is in most tool names', () => {
    const entries: IndexedTool[] = [
      ...Array.from({ length: 20 }, (_, i) => ({ server: 's', tool: tool(`get_thing_${i}`, 'Get a thing') })),
      { server: 's', tool: tool('get_invoice_pdf', 'Fetch an invoice as PDF') },
      { server: 's', tool: tool('get_thing_a', 'Get thing a') },
    ];
    expect(names(searchTools(entries, 'get invoice', 3))[0]).toBe('get_invoice_pdf');
  });

  it('weighs the name above the title above the description', () => {
    const entries: IndexedTool[] = [
      { server: 's', tool: tool('zz_a', 'Works with the widget') },
      { server: 's', tool: tool('zz_b', 'Does a thing', { title: 'Widget' }) },
      { server: 's', tool: tool('widget_c', 'Does a thing') },
      { server: 's', tool: tool('other_one', 'Does one thing') },
      { server: 's', tool: tool('other_two', 'Does two things') },
    ];
    expect(names(searchTools(entries, 'widget', 5))).toEqual(['widget_c', 'zz_b', 'zz_a']);
  });

  it('matches the start of a longer word for queries of three or more letters', () => {
    const entries: IndexedTool[] = [
      { server: 's', tool: tool('send_notification', 'Push a message') },
      { server: 's', tool: tool('list_users', 'List users') },
    ];
    expect(names(searchTools(entries, 'notif', 5))).toEqual(['send_notification']);
    expect(names(searchTools(entries, 'us', 5))).toEqual([]);
  });

  it('splits digits and camelCase in tool text, so a word is found inside an identifier', () => {
    const entries: IndexedTool[] = [
      { server: 's', tool: tool('GOOGLESHEETS_CREATE_GOOGLE_SHEET1', 'Makes a new file') },
      { server: 's', tool: tool('addBulkContactToList', 'Adds people') },
    ];
    expect(names(searchTools(entries, 'sheet', 5))).toEqual(['GOOGLESHEETS_CREATE_GOOGLE_SHEET1']);
    expect(names(searchTools(entries, 'bulk contact', 5))).toEqual(['addBulkContactToList']);
  });

  it('breaks exact ties by server, then tool name, the same way every time', () => {
    const entries: IndexedTool[] = [
      { server: 'b', tool: tool('beta_item', 'Item') },
      { server: 'a', tool: tool('beta_item_2', 'Item') },
      { server: 'a', tool: tool('alpha_item', 'Item') },
    ];
    const first = searchTools(entries, 'item', 5).map((hit) => `${hit.server}.${hit.tool.name}`);
    expect(searchTools([...entries].reverse(), 'item', 5).map((hit) => `${hit.server}.${hit.tool.name}`)).toEqual(first);
  });

  describe('twin servers', () => {
    const schema = { type: 'object', properties: { to: { type: 'string' } } };
    const twin = (server: string, extra: Partial<ToolInfo> = {}): IndexedTool => ({
      server,
      tool: tool('send_email', 'Send an email', { inputSchema: schema, ...extra }),
    });

    it('collapses servers whose tool has the same name, schema and description into one hit with alsoIn', () => {
      const hits = searchTools([twin('work'), twin('personal'), twin('shared')], 'send email', 10);
      expect(hits).toHaveLength(1);
      expect(hits[0].server).toBe('personal');
      expect(hits[0].alsoIn).toEqual(['shared', 'work']);
    });

    it('lists every twin with --no-collapse and leaves alsoIn empty', () => {
      const hits = searchTools([twin('work'), twin('personal')], 'send email', 10, { collapse: false });
      expect(hits.map((hit) => hit.server)).toEqual(['personal', 'work']);
      expect(hits.every((hit) => hit.alsoIn.length === 0)).toBe(true);
    });

    it('does not collapse tools whose schema or description differ, and ignores property order in the schema', () => {
      const differentSchema = twin('other', { inputSchema: { type: 'object', properties: { cc: { type: 'string' } } } });
      const differentText = twin('texty', { description: 'Send an email somewhere else' });
      expect(searchTools([twin('work'), differentSchema, differentText], 'send email', 10).map((hit) => hit.server).sort())
        .toEqual(['other', 'texty', 'work']);
      const reordered = twin('reordered', { inputSchema: { properties: { to: { type: 'string' } }, type: 'object' } });
      expect(searchTools([twin('work'), reordered], 'send email', 10)).toHaveLength(1);
    });

    it('ranks the distinct tools the same with or without a second server that repeats them all', () => {
      const base: IndexedTool[] = [
        { server: 'a', tool: tool('send_email', 'Send an email to a person') },
        { server: 'a', tool: tool('send_sms', 'Send a text message to a phone') },
        { server: 'a', tool: tool('list_emails', 'List the emails in a folder') },
        { server: 'a', tool: tool('delete_email', 'Delete an email for good') },
        { server: 'a', tool: tool('get_profile', 'Get the profile of the email account owner') },
      ];
      const doubled = [...base, ...base.map((entry) => ({ ...entry, server: 'b' }))];
      for (const query of ['send email', 'email', 'profile email owner', 'text message']) {
        expect(names(searchTools(doubled, query, 10)), query).toEqual(names(searchTools(base, query, 10)));
      }
    });

    it('fills the limit with distinct tools instead of repeating a twin', () => {
      const entries = [twin('a'), twin('b'), { server: 'a', tool: tool('send_sms', 'Send a text message') }];
      expect(names(searchTools(entries, 'send', 2))).toEqual(['send_email', 'send_sms']);
    });
  });
});

describe('firstSentence', () => {
  it('returns the first sentence on one line', () => {
    expect(firstSentence('Creates an issue. Supports labels.')).toBe('Creates an issue.');
    expect(firstSentence('Creates\n  an issue!  Done')).toBe('Creates an issue!');
    expect(firstSentence('Does it? Yes.')).toBe('Does it?');
  });

  it('does not stop at abbreviations, versions or file names', () => {
    expect(firstSentence('Reads data, e.g. Parquet files. Fast.')).toBe('Reads data, e.g. Parquet files.');
    expect(firstSentence('Needs v1.2 of the api or config.json to work. Next.')).toBe('Needs v1.2 of the api or config.json to work.');
  });

  it('stops at a paragraph break and handles text without a terminator', () => {
    expect(firstSentence('Lists the repos\n\nParameters: owner')).toBe('Lists the repos');
    expect(firstSentence('No terminator at all')).toBe('No terminator at all');
    expect(firstSentence('')).toBe('');
    expect(firstSentence('   ')).toBe('');
  });

  it('escapes control characters that whitespace folding leaves alone, so the result stays one line', () => {
    expect(firstSentence('Beep\u0007 then\u001b[2J clear\u0085 screen.')).toBe('Beep\\u0007 then\\u001b[2J clear\\u0085 screen.');
    expect(firstSentence(`Line${String.fromCharCode(0x2028)}break.`)).toBe('Line break.');
  });

  it('cuts overlong sentences at a word boundary with an ellipsis, within the limit', () => {
    const long = `${'word '.repeat(60).trim()}.`;
    const cut = firstSentence(long, 40);
    expect(cut.length).toBeLessThanOrEqual(40);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/wor…$/);
    expect(firstSentence('x'.repeat(200), 140)).toHaveLength(140);
  });
});

describe('nearestNames', () => {
  const names = ['create_issue', 'list_issues', 'delete_repo', 'close_issue', 'get_user', 'update_issue', 'search'];

  it('puts names containing the text first, then the closest by edit distance', () => {
    // Edit distances to "issue": close_issue 6, list_issues 6, create_issue 7, update_issue 7.
    expect(nearestNames('issue', names, 3)).toEqual(['close_issue', 'list_issues', 'create_issue']);
  });

  it('finds the intended name for a typo and returns at most five by default', () => {
    expect(nearestNames('creat_isue', names)[0]).toBe('create_issue');
    expect(nearestNames('zzzzzz', names)).toHaveLength(5);
    expect(nearestNames('x', [])).toEqual([]);
  });
});

describe('unknownServerMessage', () => {
  it('suggests registered names, or says nothing is registered', () => {
    expect(unknownServerMessage('githb', ['github', 'slack'])).toContain('Nearest: github, slack');
    expect(unknownServerMessage('x', [])).toContain('no servers are registered');
  });

  it('escapes the names it quotes', () => {
    expect(unknownServerMessage('a\nb', ['c\rd'])).toBe('Server "a\\nb" not found. Nearest: c\\rd. Run `mcpkit list` to see all registered servers.');
    expect(unknownServerMessage('a\nb', [])).toContain('Server "a\\nb" not found');
  });
});

describe('registeredServer', () => {
  const servers = { github: { name: 'github' }, constructor: { name: 'own constructor' } };

  it('returns the entry registered under an own key', () => {
    expect(registeredServer(servers, 'github')).toBe(servers.github);
    expect(registeredServer(servers, 'constructor')).toBe(servers.constructor);
  });

  it('ignores inherited properties and missing names', () => {
    for (const name of ['toString', '__proto__', 'hasOwnProperty', 'valueOf', 'missing']) {
      expect(registeredServer(servers, name), name).toBeUndefined();
    }
  });
});

describe('escapeControlChars', () => {
  it('leaves ordinary names byte for byte the same, quotes and backslashes included', () => {
    for (const name of ['create_issue', 'get-user.v2', 'repo/name', 'ünïcode ✓ 日本語', 'say "hi"', "it's", 'back\\slash', 'a\\nb', '', ' padded ']) {
      expect(escapeControlChars(name), name).toBe(name);
    }
  });

  it('writes line breaks, tabs and other C0 controls as JSON-style escapes', () => {
    expect(escapeControlChars('a\nb\rc\r\nd\te\bf\fg')).toBe('a\\nb\\rc\\r\\nd\\te\\bf\\fg');
    expect(escapeControlChars('\u0000\u0001\u001b\u001f\u007f')).toBe('\\u0000\\u0001\\u001b\\u001f\\u007f');
  });

  it('escapes the C1 controls and the Unicode line and paragraph separators', () => {
    expect(escapeControlChars('\u0085\u009f')).toBe('\\u0085\\u009f');
    expect(escapeControlChars(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`)).toBe('a\\u2028b\\u2029c');
  });

  it('turns a heading injection into plain text on one line', () => {
    const escaped = escapeControlChars('x\n## Injected');
    expect(escaped).toBe('x\\n## Injected');
    expect(escaped.split('\n')).toHaveLength(1);
  });
});

describe('jsonLine', () => {
  const nel = '\u0085';
  const lineSep = String.fromCharCode(0x2028);
  const paraSep = String.fromCharCode(0x2029);
  // What Python's str.splitlines() treats as a line break.
  const anyLineBreak = /[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/;

  it('is JSON.stringify for ordinary values', () => {
    const value = { a: 'plain "quoted" \\ text', b: [1, null, true], c: { d: 'é€😀' }, e: undefined };
    expect(jsonLine(value)).toBe(JSON.stringify(value));
  });

  it('escapes NEL, the line separator and the paragraph separator, in values and in keys', () => {
    const value = { [`k${nel}`]: [`a${nel}b`, `c${lineSep}d`, `e${paraSep}f`], plain: 'x' };
    const line = jsonLine(value);
    expect(line).not.toMatch(anyLineBreak);
    expect(line).toContain('\\u0085');
    expect(line).toContain('\\u2028');
    expect(line).toContain('\\u2029');
    expect(JSON.parse(line)).toEqual(value);
  });

  it('escapes DEL and every C1 control (U+007F to U+009F), in values and in keys, and parses back to the originals', () => {
    const controls = Array.from({ length: 0x9f - 0x7f + 1 }, (_, index) => String.fromCharCode(0x7f + index));
    const value = { [`k${controls.join('')}`]: controls.map((char) => `a${char}b`), plain: 'x' };
    const line = jsonLine(value);

    expect(line).not.toMatch(/[\u007f-\u009f]/);
    for (const char of controls) {
      expect(line).toContain(`\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    }
    expect(line).not.toMatch(anyLineBreak);
    expect(JSON.parse(line)).toEqual(value);
  });

  it('keeps one line for every other line-break character JSON already escapes', () => {
    const value = ['a\nb', 'a\rb', 'a\vb', 'a\fb', 'a\u001cb', 'a\u001db', 'a\u001eb'];
    expect(jsonLine(value)).not.toMatch(anyLineBreak);
    expect(JSON.parse(jsonLine(value))).toEqual(value);
  });

  it('does not touch a literal backslash-u sequence that was already text', () => {
    const value = { text: 'the six characters \\u0085 stay six characters' };
    expect(JSON.parse(jsonLine(value))).toEqual(value);
  });
});

describe('showing a tool that several servers have', () => {
  const work = 'Composio MCP (WORK — someone@work.com). Google Workspace: Slides, Sheets, Docs, Gmail. Tools: GMAIL_*.';
  const personal = 'Composio MCP (PERSONAL Google account). Google Workspace: Slides, Sheets, Docs, Gmail. Tools: GMAIL_*.';
  const servers = { composio: { description: work }, 'composio-personal': { description: personal }, bare: {}, blank: { description: '  \n ' } };
  const profile = tool('GMAIL_GET_PROFILE', 'Get the Gmail profile of the connected account. Needs no arguments.');
  const hit = (server: string, alsoIn: string[], extra: Partial<ToolInfo> = {}): SearchHit => ({ server, alsoIn, score: 1, tool: { ...profile, ...extra } });

  describe('clipDescription', () => {
    it('collapses white space, keeps the first max characters and drops an empty result', () => {
      expect(clipDescription('  one\n\ttwo   three  ', 100)).toBe('one two three');
      expect(clipDescription('abcdefghij', 4)).toBe('abcd');
      expect(clipDescription('ab cd ef', 3)).toBe('ab');
      expect(clipDescription(undefined, 10)).toBeUndefined();
      expect(clipDescription(' \n\t ', 10)).toBeUndefined();
    });

    it('cuts by character, never in the middle of a surrogate pair', () => {
      expect(clipDescription('a😀b😀c', 3)).toBe('a😀b');
      expect(clipDescription('😀😀😀', 2)).toBe('😀😀');
    });
  });

  describe('hitServers', () => {
    it('lists the hit server first, then the others in order, each with its trimmed registry description', () => {
      expect(hitServers(hit('composio-personal', ['bare', 'composio']), servers, 120)).toEqual([
        { server: 'composio-personal', description: personal.slice(0, 102) },
        { server: 'bare' },
        { server: 'composio', description: work },
      ]);
      expect(hitServers(hit('composio', ['composio-personal']), servers, 60)).toEqual([
        { server: 'composio', description: 'Composio MCP (WORK — someone@work.com). Google Workspace: Sl' },
        { server: 'composio-personal', description: 'Composio MCP (PERSONAL Google account). Google Workspace: Sl' },
      ]);
    });

    it('trims to the requested length and omits the description of a server that has none or a blank one', () => {
      const [first, second, third] = hitServers(hit('composio', ['bare', 'blank']), servers, 120);
      expect(first.description).toHaveLength(102);
      expect(second).toEqual({ server: 'bare' });
      expect(third).toEqual({ server: 'blank' });
      expect(Object.hasOwn(second, 'description')).toBe(false);
      expect(hitServers(hit('composio', ['bare']), servers, 20)[0].description).toBe('Composio MCP (WORK —');
    });

    it('never takes a description from the prototype of the registry: constructor and toString are not servers', () => {
      const result = hitServers(hit('constructor', ['toString', '__proto__']), {}, 120);
      expect(result).toEqual([{ server: 'constructor' }, { server: 'toString' }, { server: '__proto__' }]);
    });
  });

  describe('formatHit', () => {
    it('prints a hit with no twins as one "server.tool - summary" line, as before', () => {
      expect(formatHit(hit('github', []), servers)).toEqual(['github.GMAIL_GET_PROFILE - Get the Gmail profile of the connected account.']);
      expect(formatHit(hit('github', [], { description: '' }), servers)).toEqual(['github.GMAIL_GET_PROFILE']);
    });

    it('names every server of a shared tool equally on the first line and describes each on a second line', () => {
      expect(formatHit(hit('composio', ['composio-personal']), servers)).toEqual([
        'GMAIL_GET_PROFILE on composio, composio-personal - Get the Gmail profile of the connected account.',
        '  same tool on 2 servers: composio = Composio MCP (WORK — someone@work.com). Google Workspace: Sl; composio-personal = Composio MCP (PERSONAL Google account). Google Workspace: Sl',
      ]);
    });

    it('never starts the first line with one qualified server.tool, because that reads as the only choice', () => {
      const [first] = formatHit(hit('composio', ['composio-personal']), servers);
      expect(first.startsWith('GMAIL_GET_PROFILE on ')).toBe(true);
      expect(first).not.toMatch(/^[^ ]*composio\.GMAIL_GET_PROFILE/);
      expect(first).toContain('composio, composio-personal');
    });

    it('writes (no description) for a server without one and keeps the hit server first for every count', () => {
      expect(formatHit(hit('composio-personal', ['bare', 'composio']), servers)[1]).toBe(
        '  same tool on 3 servers: composio-personal = Composio MCP (PERSONAL Google account). Google Workspace: Sl; bare = (no description); composio = Composio MCP (WORK — someone@work.com). Google Workspace: Sl',
      );
      expect(formatHit(hit('bare', ['blank']), servers)[1]).toBe('  same tool on 2 servers: bare = (no description); blank = (no description)');
    });

    it('leaves out the dash when the tool has no description', () => {
      expect(formatHit(hit('bare', ['blank'], { description: '' }), servers)[0]).toBe('GMAIL_GET_PROFILE on bare, blank');
    });

    it('escapes control characters in server names, tool names and descriptions, after cutting', () => {
      const hostile = { 'a\u001b[2Jb': { description: 'line one\nline two \u001b[31m red\u0085x' }, plain: {} };
      const lines = formatHit(hit('a\u001b[2Jb', ['plain'], { name: 'T\nX' }), hostile);
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(line).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
      expect(lines[0]).toBe('T\\nX on a\\u001b[2Jb, plain - Get the Gmail profile of the connected account.');
      expect(lines[1]).toBe('  same tool on 2 servers: a\\u001b[2Jb = line one line two \\u001b[31m red\\u0085x; plain = (no description)');
    });

    it('cuts a description at 60 characters before escaping, so an escape is never split', () => {
      const description = `${'x'.repeat(58)}\u001bzz`;
      expect(formatHit(hit('a', ['b']), { a: { description } })[1]).toBe(`  same tool on 2 servers: a = ${'x'.repeat(58)}\\u001bz; b = (no description)`);
    });
  });
});
