/**
 * The collaborator objects `runLoop` is driven by, built where they can be
 * tested.
 *
 * `runLoop` is pure orchestration over injected collaborators, which is what
 * makes it testable -- but it pushes the wiring out to the caller, and the
 * caller was a 60-line object literal inside the CLI. BACKLOG #8 lived there:
 * the mark re-found "the first unchecked line" rather than the line the
 * iteration took, and the park ran a bare `git reset --hard` rather than
 * rewinding to the sha HEAD held before the attempt. Both halves are covered
 * by tests now, but each of those tests fakes the other side, so neither can
 * fail if the wiring between them regresses. These two factories are that
 * wiring, addressable.
 *
 * See specs/loop-adapters.yaml.
 */

import { markTaskAt, readNextTask } from './loop.mjs';
import { commitAll, headSha, park } from './loop-git.mjs';

/**
 * The checklist collaborator: reads the next unchecked task and remembers
 * which line it came from, so the later mark lands on that line rather than
 * on whatever is first-unchecked by then. The model may have edited the
 * checklist during the attempt, and a park's rewind restores it, so "first
 * unchecked" is not a stable address for the task that just ran.
 *
 * The pending line is per-adapter, not module state: one adapter serves one
 * loop, and two loops over the same file cannot tread on each other.
 *
 * @param {string} tasksFile - Checklist path
 * @returns {{ nextTask: () => Promise<string|null>, markTask: (mark: string) => Promise<{ok: boolean, error?: string}> }}
 */
export function checklistAdapter(tasksFile) {
  /** @type {number|null} */
  let pendingLine = null;

  return {
    nextTask: async () => {
      const next = await readNextTask(tasksFile);
      if (!next) {
        pendingLine = null;
        return null;
      }
      pendingLine = next.line;
      return next.text;
    },
    // A null line is out of range for markTaskAt, which returns the refusal
    // rather than defaulting to line 0 -- a mark with no task behind it is a
    // wiring fault, and the loop turns that refusal into a "mark-failed" stop.
    markTask: (mark) => markTaskAt(tasksFile, pendingLine, mark),
  };
}

/**
 * The git collaborator. `park` forwards the pre-attempt sha so the rewind
 * discards a commit the model made during the attempt; `headSha` is what
 * supplies that sha. Both are needed for the #8 fix to hold -- `headSha` is
 * optional in runLoop's contract, so omitting it here degrades silently to
 * the pre-fix behaviour.
 *
 * The return type is deliberately inferred from loop-git.mjs rather than
 * restated here: a hand-written shape would be a second contract to keep in
 * sync with the first, and runLoop's params.git is what actually pins it.
 *
 * @param {string} cwd - Workspace root
 */
export function gitAdapter(cwd) {
  return {
    commitGreen: (message) => commitAll(cwd, message),
    park: (resetPaths, resetTo) => park(cwd, resetPaths, resetTo),
    headSha: () => headSha(cwd),
  };
}
