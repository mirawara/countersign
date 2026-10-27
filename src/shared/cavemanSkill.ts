import { cp, mkdtemp, mkdir, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { CavemanStyle } from "../configuration/config";
import { CLAUDE_CAVEMAN_ULTRA } from "./claudeStyle";

const PLUGIN_NAME = "countersign-caveman";
/** Canonical name of the copied skill, as the session lists it and the slash command addresses it. */
export const SKILL_NAME = `${PLUGIN_NAME}:caveman`;
const cachedPlugins = new Map<string, Promise<{ path: string; users: number; cleanup?: NodeJS.Timeout } | undefined>>();
const cachedPluginPaths = new Set<string>();
const CACHE_IDLE_MS = 120_000;
process.once("exit", () => {
  for (const path of cachedPluginPaths) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* Process is already exiting. */ }
  }
});

/** Load only the installed Caveman skill, without the plugin's hooks or MCP servers. */
export async function prepareClaudeCavemanSkill(configDir?: string): Promise<{ path: string; dispose: () => Promise<void> } | undefined> {
  const root = configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const source = await findClaudeSkill(root);
  if (!source) return undefined;
  const signature = await skillTreeHash(source).catch(() => undefined);
  if (!signature) return undefined;
  const key = `${source}:${signature}`;
  let pending = cachedPlugins.get(key);
  if (!pending) {
    pending = createPlugin(source);
    cachedPlugins.set(key, pending);
  }
  const plugin = await pending;
  if (!plugin) { cachedPlugins.delete(key); return undefined; }
  if (plugin.cleanup) clearTimeout(plugin.cleanup);
  plugin.users += 1;
  let released = false;
  return { path: plugin.path, dispose: async () => {
    if (released) return;
    released = true;
    plugin.users -= 1;
    if (plugin.users === 0) {
      plugin.cleanup = setTimeout(() => {
        if (plugin.users !== 0) return;
        cachedPlugins.delete(key);
        void rm(plugin.path, { recursive: true, force: true }).catch(() => undefined)
          .finally(() => cachedPluginPaths.delete(plugin.path));
      }, CACHE_IDLE_MS);
      plugin.cleanup.unref();
    }
  } };
}

async function createPlugin(source: string): Promise<{ path: string; users: number; cleanup?: NodeJS.Timeout } | undefined> {
  const directory = await mkdtemp(join(tmpdir(), "countersign-caveman-")).catch(() => undefined);
  if (!directory) return undefined;
  try {
    await mkdir(join(directory, ".claude-plugin"));
    await mkdir(join(directory, "skills"));
    await writeFile(join(directory, ".claude-plugin", "plugin.json"), JSON.stringify({
      name: PLUGIN_NAME, version: "1.0.0", description: "Caveman skill selected by Countersign",
      author: { name: "Countersign" },
    }), { mode: 0o600 });
    await cp(source, join(directory, "skills", "caveman"), { recursive: true });
    cachedPluginPaths.add(directory);
    return { path: directory, users: 0 };
  } catch {
    await rm(directory, { recursive: true, force: true });
    return undefined;
  }
}

/** Cheap check for "the user has chosen Caveman for this profile", without copying anything. */
export async function claudeCavemanSkillInstalled(configDir?: string): Promise<boolean> {
  const root = configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return await findClaudeSkill(root) !== undefined;
}

/**
 * Whether the terse style also covers the text the user reads. The internal provider prose is
 * always compressed; this decides the answer. Under "auto" an installed skill is taken as the
 * user having already chosen terse output for themselves.
 */
export function cavemanCoversAnswer(style: CavemanStyle, skillInstalled: boolean): boolean {
  return style === "always" || (style === "auto" && skillInstalled);
}

/** Names the fields the user reads, so the terse style stops before the answer. */
export function plainAnswerClause(fields: string[]): string {
  const named = fields.length <= 1 ? fields[0] ?? "your answer"
    : `${fields.slice(0, -1).join(", ")} and ${fields[fields.length - 1]}`;
  return `The terse style above applies to your working notes. Write ${named} in full, ordinary sentences for a reader who did not watch this turn.`;
}

function styledPrompt(style: CavemanStyle, installed: boolean, answerFields: string[],
  instruction: string, prompt: string): string {
  return cavemanCoversAnswer(style, installed)
    ? `${instruction}\n\n${prompt}`
    : `${instruction}\n\n${plainAnswerClause(answerFields)}\n\n${prompt}`;
}

export function claudeCavemanPrompt(prompt: string, pluginPath: string | undefined,
  style: CavemanStyle, answerFields: string[]): string {
  return styledPrompt(style, pluginPath !== undefined, answerFields,
    pluginPath ? `/${SKILL_NAME} ultra` : CLAUDE_CAVEMAN_ULTRA, prompt);
}

/** CLI turns keep slash commands disabled; read the installed skill on every turn. */
export async function claudeCliCavemanPrompt(prompt: string, configDir: string | undefined,
  style: CavemanStyle, answerFields: string[]): Promise<string> {
  const root = configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const source = await findClaudeSkill(root);
  const read = source ? await readFile(join(source, "SKILL.md"), "utf8").catch(() => undefined) : undefined;
  const installed = read ? extractStyle(read) : undefined;
  return styledPrompt(style, installed !== undefined, answerFields, installed ?? CLAUDE_CAVEMAN_ULTRA, prompt);
}

export function codexCavemanPrompt(prompt: string, skillName: string | undefined,
  style: CavemanStyle, answerFields: string[]): string {
  const name = skillName ?? "caveman:caveman";
  return styledPrompt(style, skillName !== undefined, answerFields,
    `Use the $${name} skill at ultra intensity for prose in the user's language. Preserve schema keys, paths, code, commands, exact errors and evidence. If the skill is unavailable, use concise prose with those same safeguards.`,
    prompt);
}

/** Codex CLI reviews ignore user config; take only the style rules from the installed skill. */
export async function codexCliCavemanPrompt(prompt: string, codexHome: string | undefined,
  style: CavemanStyle, answerFields: string[]): Promise<string> {
  const root = codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const source = await findCodexSkill(root);
  const fallback = "Use concise prose in the user's language. Preserve schema keys, paths, code, commands, exact errors and evidence.";
  const read = source ? await readFile(source, "utf8").catch(() => undefined) : undefined;
  const installed = read ? extractStyle(read) : undefined;
  return styledPrompt(style, installed !== undefined, answerFields, installed ?? fallback, prompt);
}

function extractStyle(skill: string): string | undefined {
  const rules = skill.match(/^Drop: [^\r\n]+/m)?.[0];
  const ultra = skill.match(/^\|\s*\*\*ultra\*\*\s*\|([^\r\n]+)/m)?.[1]?.replace(/\|\s*$/, "").trim();
  const clarity = skill.match(/^Drop caveman for: [^\r\n]+/m)?.[0]
    ?? "Use full wording for safety warnings, irreversible actions and ambiguous sequences.";
  if (!rules || !ultra) return undefined;
  return [
    `Caveman Ultra from the installed skill: ${rules} Ultra: ${ultra}. ${clarity}`,
    "Apply to prose in the user's language. Preserve schema keys, paths, code, commands, exact errors and evidence.",
  ].join("\n\n");
}

/** Include support files as well as SKILL.md so an in-place skill update refreshes the copy. */
async function skillTreeHash(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string, relative: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      hash.update(child).update("\0");
      if (entry.isDirectory()) {
        hash.update("directory\0");
        await visit(path, child);
      } else if (entry.isFile()) {
        const content = await readFile(path);
        hash.update("file\0").update(String(content.length)).update("\0").update(content).update("\0");
      } else if (entry.isSymbolicLink()) {
        hash.update("link\0").update(await readlink(path)).update("\0");
      } else {
        hash.update("other\0");
      }
    }
  };
  await visit(root, "");
  return hash.digest("hex");
}

async function findClaudeSkill(root: string): Promise<string | undefined> {
  const direct = join(root, "skills", "caveman");
  if (await hasSkill(direct)) return direct;
  try {
    const raw: unknown = JSON.parse(await readFile(join(root, "plugins", "installed_plugins.json"), "utf8"));
    if (!isRecord(raw) || !isRecord(raw.plugins)) return undefined;
    const installs = raw.plugins["caveman@caveman"];
    if (!Array.isArray(installs)) return undefined;
    for (const install of installs) {
      if (!isRecord(install) || typeof install.installPath !== "string" || !isAbsolute(install.installPath)) continue;
      for (const relative of [join("skills", "caveman"), join("plugins", "caveman", "skills", "caveman")]) {
        const source = join(install.installPath, relative);
        if (await hasSkill(source)) return source;
      }
    }
  } catch { /* No installed Caveman skill: use the compact built-in instruction. */ }
  return undefined;
}

async function hasSkill(path: string): Promise<boolean> {
  try { return (await stat(join(path, "SKILL.md"))).isFile(); }
  catch { return false; }
}

async function findCodexSkill(root: string): Promise<string | undefined> {
  for (const path of [join(root, "skills", "caveman", "SKILL.md"),
    join(homedir(), ".agents", "skills", "caveman", "SKILL.md")]) {
    try { if ((await stat(path)).isFile()) return path; } catch { /* Try the next location. */ }
  }
  const cache = join(root, "plugins", "cache");
  let latest: { path: string; modified: number } | undefined;
  try {
    for (const marketplace of await readdir(cache)) {
      const plugin = join(cache, marketplace, "caveman");
      for (const version of await readdir(plugin).catch(() => [])) {
        const path = join(plugin, version, "skills", "caveman", "SKILL.md");
        const info = await stat(path).catch(() => undefined);
        if (info?.isFile() && (!latest || info.mtimeMs > latest.modified)) latest = { path, modified: info.mtimeMs };
      }
    }
  } catch { /* No plugin cache: use the compact fallback. */ }
  return latest?.path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
