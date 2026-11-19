import { afterEach, describe, expect, it, vi } from 'vitest';

type ListToolsParams = { cursor?: string } | undefined;
type RawTool = Record<string, unknown> & { name: string };
type Page = { tools: RawTool[]; nextCursor?: string };

interface MockSdkState {
  listTools: ReturnType<typeof vi.fn>;
  transports: Array<{ close: ReturnType<typeof vi.fn> }>;
}

async function importClientWithPages(pageFor: (params: ListToolsParams, call: number) => Page) {
  const state: MockSdkState = {
    listTools: vi.fn(),
    transports: [],
  };
  let call = 0;
  state.listTools.mockImplementation(async (params: ListToolsParams) => pageFor(params, call++));

  vi.resetModules();
  (globalThis as typeof globalThis & { __PKG_VERSION__?: string }).__PKG_VERSION__ = 'test';

  vi.doMock('@modelcontextprotocol/sdk/client/index.js', () => {
    class MockClient {
      connect = vi.fn(async (_transport: unknown) => {});
      listTools = state.listTools;
      getServerVersion = vi.fn(() => ({ name: 'mock-server', version: '1.0.0' }));
    }
    return { Client: MockClient };
  });

  vi.doMock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
    class MockTransport {
      close = vi.fn(async () => {});
      constructor() {
        state.transports.push(this);
      }
    }
    return { StreamableHTTPClientTransport: MockTransport };
  });

  const client = await import('./client.js');
  return { ...client, state };
}

const transport = { type: 'http' as const, url: 'http://localhost:9/mcp' };

const tool = (name: string, extra: Record<string, unknown> = {}): RawTool => ({
  name,
  inputSchema: { type: 'object' },
  ...extra,
});

afterEach(() => {
  delete (globalThis as typeof globalThis & { __PKG_VERSION__?: string }).__PKG_VERSION__;
  vi.doUnmock('@modelcontextprotocol/sdk/client/index.js');
  vi.doUnmock('@modelcontextprotocol/sdk/client/streamableHttp.js');
  vi.resetModules();
  vi.clearAllMocks();
});

describe('discoverTools pagination', () => {
  it('follows nextCursor across pages and returns every tool in order', async () => {
    const pages: Record<string, Page> = {
      first: { tools: [tool('a'), tool('b')], nextCursor: 'c1' },
      c1: { tools: [tool('c')], nextCursor: 'c2' },
      c2: { tools: [tool('d'), tool('e')] },
    };
    const { discoverTools, state } = await importClientWithPages((params) => pages[params?.cursor ?? 'first']);

    const { tools, serverMeta } = await discoverTools(transport);

    expect(tools.map((t) => t.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(serverMeta).toMatchObject({ name: 'mock-server', version: '1.0.0' });
    expect(state.listTools).toHaveBeenCalledTimes(3);
    expect(state.listTools.mock.calls.map(([params]) => params)).toEqual([
      undefined,
      { cursor: 'c1' },
      { cursor: 'c2' },
    ]);
    expect(state.transports[0].close).toHaveBeenCalledTimes(1);
  });

  it('makes a single request when there is no nextCursor', async () => {
    const { discoverTools, state } = await importClientWithPages(() => ({ tools: [tool('only')] }));

    const { tools } = await discoverTools(transport);

    expect(tools).toHaveLength(1);
    expect(state.listTools).toHaveBeenCalledTimes(1);
  });

  it('treats an empty nextCursor as the last page', async () => {
    const { discoverTools, state } = await importClientWithPages(() => ({ tools: [tool('only')], nextCursor: '' }));

    await discoverTools(transport);

    expect(state.listTools).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates tools by name across pages, keeping the first occurrence', async () => {
    const pages: Record<string, Page> = {
      first: { tools: [tool('a', { description: 'first a' }), tool('b')], nextCursor: 'c1' },
      c1: { tools: [tool('a', { description: 'second a' }), tool('c')] },
    };
    const { discoverTools } = await importClientWithPages((params) => pages[params?.cursor ?? 'first']);

    const { tools } = await discoverTools(transport);

    expect(tools.map((t) => t.name)).toEqual(['a', 'b', 'c']);
    expect(tools[0].description).toBe('first a');
  });

  it('stops when the server keeps returning the same cursor', async () => {
    const { discoverTools, state } = await importClientWithPages((_params, call) => ({
      tools: [tool(`t${call}`)],
      nextCursor: 'stuck',
    }));

    const { tools } = await discoverTools(transport);

    // First request (no cursor) -> 'stuck'; second request ('stuck') -> 'stuck' again: stop.
    expect(state.listTools).toHaveBeenCalledTimes(2);
    expect(tools.map((t) => t.name)).toEqual(['t0', 't1']);
  });

  it('stops after 100 pages when every page carries a fresh cursor', async () => {
    const { discoverTools, state } = await importClientWithPages((_params, call) => ({
      tools: [tool(`t${call}`)],
      nextCursor: `cursor-${call}`,
    }));

    const { tools } = await discoverTools(transport);

    expect(state.listTools).toHaveBeenCalledTimes(100);
    expect(tools).toHaveLength(100);
  });

  it('closes the transport when a later page fails', async () => {
    const { discoverTools, state } = await importClientWithPages((params) => {
      if (params?.cursor) throw new Error('page 2 exploded');
      return { tools: [tool('a')], nextCursor: 'c1' };
    });

    await expect(discoverTools(transport)).rejects.toThrow('page 2 exploded');
    expect(state.transports[0].close).toHaveBeenCalledTimes(1);
  });
});

describe('discoverTools field mapping', () => {
  it('maps title, outputSchema and annotations alongside the existing fields', async () => {
    const { discoverTools } = await importClientWithPages(() => ({
      tools: [
        tool('echo', {
          title: 'Echo',
          description: 'Echo a message',
          inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
          outputSchema: { type: 'object', properties: { echoed: { type: 'string' } } },
          annotations: {
            title: 'Echo (annotation)',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        }),
      ],
    }));

    const { tools } = await discoverTools(transport);

    expect(tools).toEqual([
      {
        name: 'echo',
        title: 'Echo',
        description: 'Echo a message',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
        outputSchema: { type: 'object', properties: { echoed: { type: 'string' } } },
        annotations: {
          title: 'Echo (annotation)',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ]);
  });

  it('omits the optional fields a server does not declare and defaults the description', async () => {
    const { discoverTools } = await importClientWithPages(() => ({ tools: [tool('bare')] }));

    const { tools } = await discoverTools(transport);

    expect(tools).toEqual([{ name: 'bare', description: '', inputSchema: { type: 'object' } }]);
    expect(Object.keys(tools[0])).toEqual(['name', 'description', 'inputSchema']);
  });

  it('keeps only the known annotation fields, with the protocol types', async () => {
    const { discoverTools } = await importClientWithPages(() => ({
      tools: [
        tool('odd', {
          annotations: { readOnlyHint: 'yes', destructiveHint: true, title: 7, extra: 'dropped' },
        }),
        tool('empty', { annotations: {} }),
        tool('junk', { annotations: 'not an object' }),
      ],
    }));

    const { tools } = await discoverTools(transport);

    expect(tools[0].annotations).toEqual({ destructiveHint: true });
    expect(tools[1].annotations).toBeUndefined();
    expect(tools[2].annotations).toBeUndefined();
  });
});
