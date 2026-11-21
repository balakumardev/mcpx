import { describe, it, expect, vi } from 'vitest';
import { waitForKeepAliveShutdown } from './call.js';

class FakeSignalSource {
  private handlers = new Map<string, Set<() => void>>();

  on(signal: string, handler: () => void): this {
    const existing = this.handlers.get(signal) ?? new Set<() => void>();
    existing.add(handler);
    this.handlers.set(signal, existing);
    return this;
  }

  off(signal: string, handler: () => void): this {
    this.handlers.get(signal)?.delete(handler);
    return this;
  }

  emit(signal: string): void {
    for (const handler of [...(this.handlers.get(signal) ?? [])]) {
      handler();
    }
  }

  listenerCount(signal: string): number {
    return this.handlers.get(signal)?.size ?? 0;
  }
}

describe('waitForKeepAliveShutdown', () => {
  it('closes the session once after the first shutdown signal', async () => {
    const signalSource = new FakeSignalSource();
    const stderr = { write: vi.fn() };
    const close = vi.fn(async () => {});

    const waitPromise = waitForKeepAliveShutdown(close, {
      signalSource: signalSource as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
      stderr,
    });

    expect(stderr.write).toHaveBeenCalledWith('Persistent stdio session active. Press Ctrl+C to stop.\n');
    expect(signalSource.listenerCount('SIGINT')).toBe(1);
    expect(signalSource.listenerCount('SIGTERM')).toBe(1);

    signalSource.emit('SIGINT');
    signalSource.emit('SIGTERM');

    await waitPromise;

    expect(close).toHaveBeenCalledTimes(1);
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
  });

  it('listens for the shutdown signals before it prints the line that says Ctrl+C stops the session', async () => {
    const signalSource = new FakeSignalSource();
    const listeningWhenPrinted: number[] = [];
    // A caller may send the signal as soon as it reads the line: the handlers must be on by then.
    const stderr = {
      write: vi.fn(() => {
        listeningWhenPrinted.push(signalSource.listenerCount('SIGINT'), signalSource.listenerCount('SIGTERM'));
        return true;
      }),
    };

    const waitPromise = waitForKeepAliveShutdown(async () => {}, {
      signalSource: signalSource as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
      stderr,
    });

    expect(listeningWhenPrinted).toEqual([1, 1]);
    signalSource.emit('SIGINT');
    await waitPromise;
  });
});
