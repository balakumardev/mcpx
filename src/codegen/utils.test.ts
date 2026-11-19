import { describe, expect, it } from 'vitest';
import { generateMcpTypes } from './mcp-types.js';
import { escapeJsDoc, escapeStringLiteral, quoteProp } from './utils.js';

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** What a terminal or a line reader could act on, apart from the newline and tab that text needs. */
const UNSAFE = new RegExp(`[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`);

const hostile = `x\u001b[2J\u001b]0;pwned\u0007\r\u0085\u009b31m${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}\u007f\u0000`;

describe('escapeJsDoc', () => {
  it('drops every control character except tab and newline, including CR, the C1 controls and the Unicode separators', () => {
    expect(escapeJsDoc(hostile)).toBe('x[2J]0;pwned31m');
    expect(escapeJsDoc('a\tb\nc')).toBe('a\tb\nc');
    expect(escapeJsDoc('a\r\nb')).toBe('a\nb');
  });

  it('keeps ordinary text, including non-ASCII, and still breaks up a comment terminator', () => {
    expect(escapeJsDoc('café € \u{1f600} ok')).toBe('café € \u{1f600} ok');
    expect(escapeJsDoc('end */ here')).toBe('end *\\/ here');
  });
});

describe('escapeStringLiteral and quoteProp', () => {
  it('writes every control character, the C1 controls included, as an escape', () => {
    const quoted = escapeStringLiteral(hostile);
    expect(quoted).not.toMatch(UNSAFE);
    expect(quoted).toBe('x\\u001b[2J\\u001b]0;pwned\\u0007\\r\\u0085\\u009b31m\\u2028\\u2029\\u007f\\u0000');
    expect(quoteProp(hostile)).toBe(`"${quoted}"`);
  });

  it('parses back to the original string as a JSON string', () => {
    expect(JSON.parse(`"${escapeStringLiteral(hostile)}"`)).toBe(hostile);
  });

  it('leaves ordinary names alone', () => {
    expect(quoteProp('create_issue')).toBe('create_issue');
    expect(quoteProp('has space')).toBe('"has space"');
    expect(escapeStringLiteral('café "q" \\ ok')).toBe('café \\"q\\" \\\\ ok');
  });
});

describe('generateMcpTypes prints server-provided text safely', () => {
  it('writes no raw control character from names, descriptions, enums or defaults', () => {
    const declarations = generateMcpTypes([{
      server: `srv${hostile}`,
      tools: [{
        name: `tool${hostile}`,
        description: `Does a thing ${hostile}\n\nSecond paragraph`,
        inputSchema: {
          type: 'object',
          properties: { [`p${hostile}`]: { type: 'string', description: `param ${hostile}`, enum: [`e${hostile}`] } },
          required: [`p${hostile}`],
        },
        outputSchema: { type: 'object', properties: { [`o${hostile}`]: { const: `c${hostile}` } } },
      }],
    }]);
    expect(declarations).not.toMatch(UNSAFE);
    expect(declarations).toContain('Second paragraph');
  });
});
