import { createProgram } from './program.js';
import { reconcileBeforeAction } from './reconcile.js';

const program = createProgram(__PKG_VERSION__);

// In front of every command that is about to run (nested ones included): bring the skills and the guide
// in line with the default lean mode. It decides from the command's class (see `classifyCommand`), never
// throws, and prints only on stderr, so the command's own output and exit code are what they were.
program.hook('preAction', async (_program, actionCommand) => {
  await reconcileBeforeAction(actionCommand);
});

// Not `await program.parseAsync(...)`: a top-level await on a promise that never settles (`call --keepalive`
// once its server has died: nothing is left that could settle it) makes Node end the process with status 13,
// "unsettled top-level await", where the event loop alone ended it with 0 before. `parse` starts the same
// chain, in which commander awaits the async preAction hook above before it runs the action, and leaves the
// ending of the process to the event loop. An action that rejects is an unhandled rejection, as it always was:
// the error and its stack on stderr, exit status 1.
program.parse(process.argv);
