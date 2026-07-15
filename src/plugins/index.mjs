/**
 * Plugin host — activates in-tree output-sink plugins as reporters.
 *
 * A plugin is a host-driven observer, distinct from tools and skills (which the
 * model invokes) and from hooks (user shell commands that feed back to the
 * model). A plugin rides the reporter channel (specs/reporter.yaml): its setup()
 * returns a Reporter, and the harness fans the run's reporter out to it.
 *
 * Plugins are in-tree (no dynamic loading) and off by default. A plugin is
 * activated only when named in .kodr/plugins.json or force-enabled by the
 * caller (--plugin). A plugin whose setup returns { error } is skipped with a
 * notice — it never blocks the run.
 */

import { readFile } from 'node:fs/promises';
import { resolveExistingPath } from '../path-jail.mjs';
import telegram from './telegram.mjs';

const ALL_PLUGINS = [telegram];
const CONFIG_PATH = '.kodr/plugins.json';

/**
 * Activate the configured/enabled plugins and return their reporters.
 * @param {string} cwd - Workspace root
 * @param {object} [options]
 * @param {object} [options.config] - Activation config { plugins: { <name>: cfg } }
 * @param {string[]} [options.enabled] - Plugin names force-enabled (e.g. via --plugin)
 * @param {object} [options.env] - Environment for plugin setup (defaults to process.env)
 * @param {(text: string) => void} [options.notice] - Sink for disabled-plugin notices
 * @returns {Promise<import('../reporter.mjs').Reporter[]>}
 */
export async function activateReporterPlugins(cwd, options = {}) {
  const { env = process.env, notice = () => {} } = options;
  const config = options.config ?? (await loadConfig(cwd));
  const active = activeNames(config, options.enabled ?? []);
  if (active.size === 0) {
    return [];
  }

  const ctx = { cwd, env };
  const reporters = [];
  for (const plugin of ALL_PLUGINS) {
    if (!active.has(plugin.name)) {
      continue;
    }
    const pluginConfig = config?.plugins?.[plugin.name] ?? {};
    const result = plugin.setup(pluginConfig, ctx);
    if (result?.error) {
      notice(result.error);
      continue;
    }
    reporters.push(result);
  }
  return reporters;
}

/**
 * The set of plugin names to activate: those listed in config.plugins plus any
 * force-enabled by the caller.
 * @param {object|null} config
 * @param {string[]} enabled
 * @returns {Set<string>}
 */
function activeNames(config, enabled) {
  const names = new Set(enabled);
  if (config?.plugins) {
    for (const name of Object.keys(config.plugins)) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Load .kodr/plugins.json from the workspace, path-jailed. A missing or
 * malformed file activates no plugins.
 * @param {string} cwd
 * @returns {Promise<object|null>}
 */
export async function loadConfig(cwd) {
  let resolved;
  try {
    resolved = await resolveExistingPath(cwd, CONFIG_PATH);
  } catch {
    return null;
  }
  if (!resolved) {
    return null;
  }

  try {
    const raw = await readFile(resolved, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // missing or malformed: no plugins
  }
  return null;
}

export { CONFIG_PATH };
