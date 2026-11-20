/**
 * A server that uses OAuth needs the user to sign in, and the command that hit it is not allowed to
 * start a sign-in (it never opens a browser or waits for a callback). Batch commands skip such a
 * server and say how to sign in; single-target commands print this message and fail.
 *
 * Kept in a module of its own, with no imports, so any layer can throw or recognise it without
 * pulling in the OAuth provider.
 */
export class OAuthRequiredError extends Error {
  readonly serverName: string;

  constructor(serverName: string) {
    super(`${serverName} needs sign-in. Run: mcpkit auth ${serverName}`);
    this.name = 'OAuthRequiredError';
    this.serverName = serverName;
  }
}
