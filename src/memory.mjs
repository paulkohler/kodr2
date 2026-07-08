/**
 * End-of-run retrospective.
 *
 * After a run's tool loop reaches an outcome, distill the conversation
 * and ask the model to propose lessons for future runs in this workspace.
 * This never writes to MEMORY.md silently: it always produces a
 * *proposal*, and a human decides whether it becomes part of the
 * workspace's memory -- an unreviewed proposal from one bad run could
 * otherwise quietly bias every run after it, with nothing catching it the
 * way a human catches a bad edit to a hand-written KODR.md.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { renderTranscript } from './compact.mjs';
import { remainingRunBudgetMs } from './tool-loop.mjs';

export const MEMORY_FILE = 'MEMORY.md';
export const DEFAULT_MEMORY_RESERVE = 0.1;
export const DEFAULT_MEMORY_SIZE_CAP = 8_000;
export const DEFAULT_MEMORY_PROMPT_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Timeout for the attended y/N prompt. Resolved from an explicit option,
 * then KODR_MEMORY_PROMPT_TIMEOUT_MS, then the default. A defensive
 * backstop against attended being miscomputed (or stdin simply not being
 * interactive despite stdout being a TTY) -- without this, an unanswered
 * readline question() never resolves on its own, hanging the whole
 * process indefinitely with no notice.
 * @param {number} [option]
 * @returns {number}
 */
export function memoryPromptTimeoutMs(option) {
  if (Number.isInteger(option) && option >= 0) {
    return option;
  }
  const fromEnv = Number.parseInt(
    process.env.KODR_MEMORY_PROMPT_TIMEOUT_MS,
    10,
  );
  if (Number.isInteger(fromEnv) && fromEnv >= 0) {
    return fromEnv;
  }
  return DEFAULT_MEMORY_PROMPT_TIMEOUT_MS;
}

const RETROSPECTIVE_SYSTEM = `You just finished a coding session in this workspace. Reflect on what would have helped you (or another instance of yourself) get to the right answer faster or avoid a wrong turn -- a mistaken assumption, a dead end you had to backtrack from, a workspace-specific convention you only discovered partway through, or a gotcha in this codebase's tooling or tests.

Write a short, concrete addition to this workspace's persistent memory file, in a few sentences or a short bullet list. Be specific -- name files, commands, or patterns, not generic advice ("write tests", "read the docs first") that would apply to any project.

If nothing from this session would meaningfully change how a future run approaches this workspace, reply with exactly: No findings.`;

/**
 * Whether the end-of-run retrospective is enabled, via the memory option
 * or KODR_MEMORY ("1"/"true"). Off by default.
 * @param {boolean} [option]
 * @returns {boolean}
 */
export function isMemoryEnabled(option) {
  if (option === true) {
    return true;
  }
  const env = process.env.KODR_MEMORY;
  return env === '1' || env === 'true';
}

/**
 * Fraction of the run budget the retrospective refuses to spend into,
 * mirroring healReserveFraction (harness.mjs). Resolved from an explicit
 * option, then KODR_MEMORY_RESERVE, then the default; clamped to [0, 0.9].
 * @param {number} [option]
 * @returns {number}
 */
export function memoryReserveFraction(option) {
  let fraction = DEFAULT_MEMORY_RESERVE;
  const fromEnv = Number.parseFloat(process.env.KODR_MEMORY_RESERVE);
  if (Number.isFinite(fromEnv)) {
    fraction = fromEnv;
  }
  if (Number.isFinite(option)) {
    fraction = option;
  }
  if (fraction < 0) {
    return 0;
  }
  if (fraction > 0.9) {
    return 0.9;
  }
  return fraction;
}

/**
 * Size cap for MEMORY.md, in characters. Resolved from an explicit
 * option, then KODR_MEMORY_SIZE_CAP, then the default.
 * @param {number} [option]
 * @returns {number}
 */
export function memorySizeCap(option) {
  if (Number.isInteger(option) && option > 0) {
    return option;
  }
  const fromEnv = Number.parseInt(process.env.KODR_MEMORY_SIZE_CAP, 10);
  if (Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_MEMORY_SIZE_CAP;
}

/**
 * Budget cap for the retrospective model call: the remaining run budget
 * minus the reserve. Returns undefined when no run budget is set, mirroring
 * stopVerifyBudgetMs (harness.mjs) -- unlimited unless a deadline exists.
 * @param {Date} startedAt
 * @param {number} maxRunMs
 * @param {number} reserveFraction
 * @returns {number|undefined}
 */
export function retrospectiveBudgetMs(startedAt, maxRunMs, reserveFraction) {
  const remaining = remainingRunBudgetMs(startedAt, maxRunMs);
  if (remaining === undefined) {
    return undefined;
  }
  return Math.floor(remaining * (1 - reserveFraction));
}

/**
 * Read MEMORY.md at the workspace root.
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
export async function readMemory(cwd) {
  try {
    const content = await readFile(join(cwd, MEMORY_FILE), 'utf8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

/**
 * A notice when MEMORY.md is over its size cap. The full content is still
 * used either way -- this never truncates, it only flags that a human
 * should prune it.
 * @param {string|null} content
 * @param {number} cap
 * @returns {string|null}
 */
export function memorySizeNotice(content, cap) {
  if (!content || content.length <= cap) {
    return null;
  }
  return `MEMORY.md is ${content.length} characters, over the ${cap}-character cap -- consider pruning it`;
}

/**
 * Append notes to MEMORY.md under a dated heading. Never rewrites or
 * drops existing content, so a human's own edits survive.
 *
 * Appends via the OS-level 'a' (O_APPEND) flag rather than a
 * read-then-write-whole-file -- nothing here reads the file first. Two
 * concurrent kodr processes targeting the same workspace (a scheduled
 * dogfood run overlapping a manual one, say) would otherwise race:
 * both read the same "before" content, and whichever writes last
 * silently wins, discarding the other's entry entirely. A single
 * O_APPEND write is atomic at the OS level for writes this size, so both
 * entries always land, just in whichever order the OS happened to
 * schedule them. The tradeoff: a brand-new MEMORY.md gets a harmless
 * leading blank line, since there's no way to know "is this the first
 * entry" without reading first.
 * @param {string} cwd
 * @param {string} notes
 * @returns {Promise<void>}
 */
export async function appendMemoryNotes(cwd, notes) {
  const path = join(cwd, MEMORY_FILE);
  const entry = `\n## ${new Date().toISOString()}\n\n${notes}\n`;
  await writeFile(path, entry, { flag: 'a' });
}

/**
 * Write a proposal to a flat file peer to the run transcript (matching
 * this codebase's actual runsDir layout: run transcripts, incident
 * records, and heartbeats are all flat files distinguished by suffix, not
 * per-run subdirectories).
 * @param {string} runsDir
 * @param {string} notes
 * @returns {Promise<string>} Path written
 */
export async function writeMemoryProposal(runsDir, notes) {
  await mkdir(runsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  // The random suffix guards the same collision incident.mjs's
  // writeIncident hit: a millisecond-resolution timestamp alone can
  // collide and silently overwrite when two retrospectives land in the
  // same process tick.
  const path = join(
    runsDir,
    `${timestamp}-${randomUUID().slice(0, 8)}.memory-proposal.md`,
  );
  await writeFile(path, notes, 'utf8');
  return path;
}

/**
 * Prompt the operator with a yes/no question. Overridable input/output
 * for tests, so this never blocks on real stdin in a test run.
 *
 * Bounded by a timeout: readline's question() only ever resolves on a
 * `line` event, never on its own on EOF/an interface close, and closing
 * the interface does not reject or resolve a pending question either --
 * confirmed directly, an abandoned question() just hangs forever with no
 * signal at all. If attended somehow gets computed true against a stream
 * that isn't genuinely interactive (piped/redirected stdin, say), this
 * timeout is what keeps the whole process from hanging indefinitely with
 * no notice.
 * @param {string} question
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<boolean|null>} null means no answer was obtained (timed out)
 */
export async function promptYesNo(question, options = {}) {
  const { input = process.stdin, output = process.stdout } = options;
  const timeoutMs = memoryPromptTimeoutMs(options.timeoutMs);
  const rl = createInterface({ input, output });
  let timer;
  try {
    const answer = await Promise.race([
      rl.question(question),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (answer === null) {
      return null;
    }
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    clearTimeout(timer);
    rl.close();
  }
}

function isNoFindings(notes) {
  return /^no findings\.?$/i.test(notes);
}

/**
 * Run the end-of-run retrospective. Never writes to MEMORY.md without a
 * human decision in the loop -- see the module doc comment.
 * @param {object} params
 * @param {object} params.client - Model client
 * @param {string} params.modelId - Model to generate the retrospective with
 * @param {Array} params.messages - Full conversation from the run just finished
 * @param {string} params.cwd - Workspace root
 * @param {Date} [params.startedAt]
 * @param {number} [params.maxRunMs] - Run budget in ms (0 disables)
 * @param {number} [params.memoryReserve] - Fraction of the budget to refuse to spend (default 0.1)
 * @param {number} params.toolTurns - Tool-invoking turns from the run just finished (0 skips)
 * @param {string} params.runsDir - Where to write an unattended proposal file
 * @param {boolean} [params.attended] - Whether to prompt inline for confirmation
 * @param {boolean} [params.autoApply] - Skip the confirmation prompt and apply directly
 * @param {boolean} [params.noSave] - Skip writing the proposal file into runsDir (mirrors
 *   the run's own noSave) -- the notes are still returned either way, since applying
 *   directly to MEMORY.md (autoApply, or an attended "yes") has nothing to do with
 *   runsDir hygiene and must keep working under noSave
 * @param {function} [params.promptYesNoFn] - Overridable for tests; defaults to this module's promptYesNo
 * @returns {Promise<{ proposed: boolean, notes?: string, applied?: boolean, proposalPath?: string|null, usage?: object, retries?: number, error?: string }>}
 */
export async function runMemoryRetrospective(params) {
  const {
    client,
    modelId,
    messages,
    cwd,
    startedAt,
    maxRunMs = 0,
    toolTurns,
    runsDir,
    attended = false,
    autoApply = false,
    noSave = false,
    promptYesNoFn = promptYesNo,
  } = params;

  if (!toolTurns) {
    return { proposed: false };
  }

  const reserveFraction = memoryReserveFraction(params.memoryReserve);
  const budgetMs = retrospectiveBudgetMs(startedAt, maxRunMs, reserveFraction);
  if (budgetMs !== undefined && budgetMs <= 0) {
    return { proposed: false };
  }

  const history = messages.filter((message) => message.role !== 'system');
  if (history.length === 0) {
    return { proposed: false };
  }

  const transcript = renderTranscript(history);
  let response;
  try {
    response = await client.chat({
      model: modelId,
      messages: [
        { role: 'system', content: RETROSPECTIVE_SYSTEM },
        { role: 'user', content: `Session transcript:\n\n${transcript}` },
      ],
      timeoutMs: budgetMs,
    });
  } catch (err) {
    return { proposed: false, error: err.message, retries: err.retries ?? 0 };
  }

  const notes = (response.message.content || '').trim();
  const usage = response.usage || { prompt: 0, completion: 0, cost: 0 };
  const retries = response.retries || 0;

  if (!notes || isNoFindings(notes)) {
    return {
      proposed: true,
      notes: '',
      applied: false,
      proposalPath: null,
      usage,
      retries,
    };
  }

  if (autoApply) {
    await appendMemoryNotes(cwd, notes);
    return {
      proposed: true,
      notes,
      applied: true,
      proposalPath: null,
      usage,
      retries,
    };
  }

  if (attended) {
    const confirmed = await promptYesNoFn(
      `\n${notes}\n\nKeep these notes for future runs? [y/N] `,
    );
    if (confirmed === true) {
      await appendMemoryNotes(cwd, notes);
      return {
        proposed: true,
        notes,
        applied: true,
        proposalPath: null,
        usage,
        retries,
      };
    }
    if (confirmed === null) {
      // Timed out -- couldn't get a real answer (e.g. attended was
      // miscomputed against a stream that isn't genuinely interactive).
      // Fall back to the same persisted-proposal path an unattended
      // session gets, rather than silently discarding a real answer we
      // just never received.
      return {
        proposed: true,
        notes,
        applied: false,
        proposalPath: await persistProposal(runsDir, notes, noSave),
        usage,
        retries,
      };
    }
    return {
      proposed: true,
      notes,
      applied: false,
      proposalPath: null,
      usage,
      retries,
    };
  }

  return {
    proposed: true,
    notes,
    applied: false,
    proposalPath: await persistProposal(runsDir, notes, noSave),
    usage,
    retries,
  };
}

/**
 * Write the unattended/fallback proposal file -- unless noSave is set, in
 * which case the notes are still returned to the caller (so --json output
 * or a programmatic caller can still see them) but nothing is written to
 * runsDir, matching noSave's actual purpose (a clean-workspace/benchmark
 * run shouldn't get an extra file it didn't ask for). This is narrower
 * than gating the whole retrospective behind noSave -- --memory-auto-apply
 * writes directly to MEMORY.md at the workspace root, unrelated to runsDir
 * hygiene, and must keep working under --no-save.
 * @param {string} runsDir
 * @param {string} notes
 * @param {boolean} [noSave]
 * @returns {Promise<string|null>}
 */
async function persistProposal(runsDir, notes, noSave) {
  if (noSave) {
    return null;
  }
  return writeMemoryProposal(runsDir, notes);
}
