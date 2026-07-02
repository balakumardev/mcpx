// Transport types
export type TransportType = 'stdio' | 'http' | 'sse';
export type AuthType = 'oauth';
export type RuntimeMode = 'ephemeral' | 'persistent';

export const DEFAULT_RUNTIME_IDLE_TIMEOUT_SEC = 15 * 60;
export const DEFAULT_RUNTIME_CALL_TIMEOUT_SEC = 30 * 60;

// Default staleness window for auto-refresh: re-discover tools + regenerate the
// skill file if the last discovery is older than this. Suits dynamic servers
// (aggregators/proxies whose tool list changes over time, e.g. DAST orchestrator).
export const DEFAULT_AUTO_REFRESH_TTL_SEC = 24 * 60 * 60;

export interface OAuthConfig {
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
}

export interface StdioTransportConfig {
  type: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface HttpTransportConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  auth?: AuthType;
  oauth?: OAuthConfig;
}

export interface SseTransportConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
  auth?: AuthType;
  oauth?: OAuthConfig;
}

export type TransportConfig = StdioTransportConfig | HttpTransportConfig | SseTransportConfig;

// Param provider — runs a command before each tool call and merges JSON output into params
export interface ParamProviderConfig {
  command: string;    // shell command to run (e.g. "eiamcli iamticket")
  args?: string[];    // optional arguments
  ttl?: number;       // cache TTL in seconds (default: 0 = no cache)
}

export interface ServerRuntimeConfig {
  mode: RuntimeMode;
  idleTimeoutSec?: number;
  callTimeoutSec?: number;
}

// Auto-refresh — for dynamic servers whose tool set drifts over time. When
// enabled, `mcpkit call` re-discovers tools and regenerates skill files in the
// background if the last discovery is older than `ttlSec`. The refresh is
// best-effort: a discovery failure never blocks or fails the actual tool call.
export interface AutoRefreshConfig {
  enabled: boolean;
  ttlSec?: number;         // staleness window (default: DEFAULT_AUTO_REFRESH_TTL_SEC)
  lastRefreshedAt?: string; // ISO timestamp of last successful discovery
}

// Registry types
export interface ServerEntry {
  name: string;
  transport: TransportConfig;
  description?: string;
  paramProvider?: ParamProviderConfig;
  runtime?: ServerRuntimeConfig;
  /**
   * Custom hints surfaced when a `${VAR}` reference in headers/env is missing
   * at call time. Keyed by env-var name; the value is a free-form recipe shown
   * after the standard "Environment variable X is not set" error. Generic —
   * the per-server config supplies whatever recipe makes sense for the server
   * (e.g. how to mint an auth token).
   */
  envHints?: Record<string, string>;
  autoRefresh?: AutoRefreshConfig;
  toolCount: number;
  agents: AgentType[];
  agentSelectionMode?: AgentSelectionMode;
  createdAt: string;
  updatedAt: string;
}

export interface ServerRegistry {
  version: 1;
  servers: Record<string, ServerEntry>;
}

// Tool types
export interface ToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Agent types
export type AgentType = 'claude-code' | 'cursor' | 'codex' | 'windsurf' | 'augment' | 'openclaw' | 'hermes';

export const ALL_AGENTS: AgentType[] = ['claude-code', 'cursor', 'codex', 'windsurf', 'augment', 'openclaw', 'hermes'];

export type AgentSelectionMode = 'defaults' | 'explicit';

export type Scope = 'global' | 'project';

export interface AgentSettings {
  version: 1;
  enabledAgents: AgentType[];
  updatedAt: string;
}

// Server metadata from MCP initialize + npm registry
export interface ServerMeta {
  name?: string;
  version?: string;
  instructions?: string;
  packageDescription?: string;
}

// Generator types
export interface GeneratedSkill {
  agent: AgentType;
  scope: Scope;
  filePath: string;
  content: string;
  isAppend: boolean;
}

export interface GeneratorContext {
  serverName: string;
  description?: string;
  serverMeta?: ServerMeta;
  tools: ToolInfo[];
  transport: TransportConfig;
  scope: Scope;
  runtime?: ServerRuntimeConfig;
  paramProvider?: ParamProviderConfig;
}
