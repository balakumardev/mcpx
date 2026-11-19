import { describe, expect, it } from 'vitest';
import { describeOmittedParts, normalizeToolResult } from './tool-result.js';

const text = (value: string) => ({ type: 'text', text: value });
const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };

describe('normalizeToolResult', () => {
  const cases: Array<{
    name: string;
    raw: unknown;
    expected: { isError: boolean; value: unknown; text: string };
  }> = [
    {
      name: 'prefers structuredContent as the value and keeps the text parts as text',
      raw: { structuredContent: { echoed: 'hi' }, content: [text('{"echoed":"hi"}')] },
      expected: { isError: false, value: { echoed: 'hi' }, text: '{"echoed":"hi"}' },
    },
    {
      name: 'uses structuredContent even when the content parts are not text',
      raw: { structuredContent: { n: 1 }, content: [image] },
      expected: { isError: false, value: { n: 1 }, text: '{"n":1}' },
    },
    {
      name: 'renders structuredContent as JSON text when there are no text parts',
      raw: { structuredContent: { a: [1, 2] } },
      expected: { isError: false, value: { a: [1, 2] }, text: '{"a":[1,2]}' },
    },
    {
      name: 'parses a JSON object in a single text part',
      raw: { content: [text('{"items":[1,2,3]}')] },
      expected: { isError: false, value: { items: [1, 2, 3] }, text: '{"items":[1,2,3]}' },
    },
    {
      name: 'parses a JSON number',
      raw: { content: [text('42')] },
      expected: { isError: false, value: 42, text: '42' },
    },
    {
      name: 'parses a JSON null',
      raw: { content: [text('null')] },
      expected: { isError: false, value: null, text: 'null' },
    },
    {
      name: 'keeps plain text as a string',
      raw: { content: [text('hello world')] },
      expected: { isError: false, value: 'hello world', text: 'hello world' },
    },
    {
      name: 'joins several text parts with newlines and keeps the string when the join is not JSON',
      raw: { content: [text('{"a":1}'), text('{"b":2}')] },
      expected: { isError: false, value: '{"a":1}\n{"b":2}', text: '{"a":1}\n{"b":2}' },
    },
    {
      name: 'parses several text parts when the joined text is valid JSON',
      raw: { content: [text('['), text('1,2]')] },
      expected: { isError: false, value: [1, 2], text: '[\n1,2]' },
    },
    {
      name: 'returns { content } when any part is not text, with only the text parts as text',
      raw: { content: [text('caption'), image] },
      expected: {
        isError: false,
        value: { content: [text('caption'), image] },
        text: 'caption',
      },
    },
    {
      name: 'returns { content } and empty text for image-only results',
      raw: { content: [image] },
      expected: { isError: false, value: { content: [image] }, text: '' },
    },
    {
      name: 'treats a text part without a string body as non-text',
      raw: { content: [{ type: 'text' }] },
      expected: { isError: false, value: { content: [{ type: 'text' }] }, text: '' },
    },
    {
      name: 'flags isError and keeps the message text',
      raw: { isError: true, content: [text('boom: bad input')] },
      expected: { isError: true, value: 'boom: bad input', text: 'boom: bad input' },
    },
    {
      name: 'flags isError on a JSON error body and parses it',
      raw: { isError: true, content: [text('{"code":404}')] },
      expected: { isError: true, value: { code: 404 }, text: '{"code":404}' },
    },
    {
      name: 'does not treat isError:false or a non-boolean as an error',
      raw: { isError: 'true', content: [text('ok')] },
      expected: { isError: false, value: 'ok', text: 'ok' },
    },
    {
      name: 'handles an empty result',
      raw: { content: [] },
      expected: { isError: false, value: '', text: '' },
    },
    {
      name: 'handles a missing content array',
      raw: {},
      expected: { isError: false, value: '', text: '' },
    },
    {
      name: 'treats a null structuredContent as absent',
      raw: { structuredContent: null, content: [text('plain')] },
      expected: { isError: false, value: 'plain', text: 'plain' },
    },
    {
      name: 'tolerates a non-object result',
      raw: undefined,
      expected: { isError: false, value: '', text: '' },
    },
  ];

  it.each(cases)('$name', ({ raw, expected }) => {
    expect(normalizeToolResult(raw)).toEqual(expected);
  });
});

describe('describeOmittedParts', () => {
  it('describes an image by its MIME type and its decoded size', () => {
    expect(describeOmittedParts([text('shot'), { type: 'image', data: 'AAAA', mimeType: 'image/png' }])).toEqual(['image/png 3 bytes']);
    expect(describeOmittedParts([text('shot'), { type: 'image', data: 'AAA=', mimeType: 'image/png' }])).toEqual(['image/png 2 bytes']);
  });

  it('describes a result that holds nothing but non-text parts', () => {
    expect(describeOmittedParts([image])).toEqual(['image/png 3 bytes']);
  });

  it('falls back to the part type, and drops the size when there is no data', () => {
    expect(describeOmittedParts([text('x'), { type: 'audio', data: 'AAAA' }])).toEqual(['audio 3 bytes']);
    expect(describeOmittedParts([text('x'), { type: 'image', mimeType: 'image/gif' }])).toEqual(['image/gif']);
    expect(describeOmittedParts([text('x'), { type: 'something_new', whatever: 1 }])).toEqual(['something_new']);
    expect(describeOmittedParts([{ whatever: 1 }])).toEqual(['unknown']);
  });

  it('describes resource links by uri and embedded resources by uri and size', () => {
    expect(describeOmittedParts([text('x'), { type: 'resource_link', uri: 'file:///a', name: 'a' }])).toEqual(['resource_link file:///a']);
    expect(describeOmittedParts([text('x'), { type: 'resource', resource: { uri: 'mem://t', text: 'héllo' } }])).toEqual(['resource mem://t 6 bytes']);
    expect(describeOmittedParts([text('x'), { type: 'resource', resource: { uri: 'mem://b', blob: 'AAAA' } }])).toEqual(['resource mem://b 3 bytes']);
    expect(describeOmittedParts([text('x'), { type: 'resource' }])).toEqual(['resource']);
  });

  it('groups parts of one kind, adding their sizes, in order of first appearance', () => {
    const parts = [text('x'), { type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'audio', data: 'AAAA' }, { type: 'image', data: 'AAAAAAAA', mimeType: 'image/png' }];
    expect(describeOmittedParts(parts)).toEqual(['2 x image/png, 9 bytes', 'audio 3 bytes']);
  });

  it('describes nothing when every part is text, or when there is no content list', () => {
    expect(describeOmittedParts([text('only text')])).toEqual([]);
    expect(describeOmittedParts([])).toEqual([]);
    for (const content of [undefined, null, 'text', 5, {}, { type: 'image' }]) {
      expect(describeOmittedParts(content)).toEqual([]);
    }
  });

  it('skips list entries that are not objects', () => {
    expect(describeOmittedParts([null, 5, 'x', image])).toEqual(['image/png 3 bytes']);
  });
});
