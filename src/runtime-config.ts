import {
  DEFAULT_RUNTIME_CALL_TIMEOUT_SEC,
  DEFAULT_RUNTIME_IDLE_TIMEOUT_SEC,
  type RuntimeMode,
  type ServerEntry,
  type ServerRuntimeConfig,
  type TransportConfig,
} from './types.js';

export interface ResolvedRuntimeConfig {
  mode: RuntimeMode;
  idleTimeoutSec: number;
  callTimeoutSec: number;
}

export function normalizeRuntimeMode(mode?: string): RuntimeMode | undefined {
  if (mode === undefined) return undefined;
  if (mode === 'ephemeral' || mode === 'persistent') return mode;
  throw new Error(`Invalid runtime mode "${mode}". Use "ephemeral" or "persistent".`);
}

export function validateRuntimeIdleTimeout(idleTimeoutSec?: number): number | undefined {
  if (idleTimeoutSec === undefined) return undefined;
  if (!Number.isInteger(idleTimeoutSec) || idleTimeoutSec <= 0) {
    throw new Error('Runtime idle timeout must be a positive integer number of seconds.');
  }
  return idleTimeoutSec;
}

export function validateRuntimeCallTimeout(callTimeoutSec?: number): number | undefined {
  if (callTimeoutSec === undefined) return undefined;
  if (!Number.isInteger(callTimeoutSec) || callTimeoutSec <= 0) {
    throw new Error('Runtime call timeout must be a positive integer number of seconds.');
  }
  return callTimeoutSec;
}

export function normalizeRuntimeConfig(runtime?: ServerRuntimeConfig): ServerRuntimeConfig | undefined {
  if (!runtime) return undefined;
  if (
    runtime.mode === 'ephemeral'
    && runtime.idleTimeoutSec === undefined
    && runtime.callTimeoutSec === undefined
  ) return undefined;
  return runtime;
}

export function resolveRuntimeConfig(
  runtime?: ServerRuntimeConfig,
): ResolvedRuntimeConfig {
  return {
    mode: runtime?.mode ?? 'ephemeral',
    idleTimeoutSec: runtime?.idleTimeoutSec ?? DEFAULT_RUNTIME_IDLE_TIMEOUT_SEC,
    callTimeoutSec: runtime?.callTimeoutSec ?? DEFAULT_RUNTIME_CALL_TIMEOUT_SEC,
  };
}

export function buildRuntimeConfig(
  transport: TransportConfig,
  modeInput?: string,
  idleTimeoutSecInput?: number,
  callTimeoutSecInput?: number,
): ServerRuntimeConfig | undefined {
  const mode = normalizeRuntimeMode(modeInput);
  const idleTimeoutSec = validateRuntimeIdleTimeout(idleTimeoutSecInput);
  const callTimeoutSec = validateRuntimeCallTimeout(callTimeoutSecInput);

  if (transport.type !== 'stdio') {
    if (mode === 'persistent' || idleTimeoutSec !== undefined || callTimeoutSec !== undefined) {
      throw new Error('Persistent runtimes are only supported for stdio servers.');
    }
    return undefined;
  }

  if (mode === undefined && idleTimeoutSec === undefined && callTimeoutSec === undefined) {
    return undefined;
  }

  const resolvedMode: RuntimeMode = mode ?? (
    idleTimeoutSec !== undefined || callTimeoutSec !== undefined ? 'persistent' : 'ephemeral'
  );
  if (resolvedMode !== 'persistent' && (idleTimeoutSec !== undefined || callTimeoutSec !== undefined)) {
    throw new Error('Runtime idle timeout and call timeout can only be set when runtime mode is "persistent".');
  }

  return normalizeRuntimeConfig({
    mode: resolvedMode,
    ...(idleTimeoutSec !== undefined ? { idleTimeoutSec } : {}),
    ...(callTimeoutSec !== undefined ? { callTimeoutSec } : {}),
  });
}

export function isPersistentRuntimeEntry(
  entry: Pick<ServerEntry, 'transport' | 'runtime'>,
): boolean {
  return entry.transport.type === 'stdio' && resolveRuntimeConfig(entry.runtime).mode === 'persistent';
}
