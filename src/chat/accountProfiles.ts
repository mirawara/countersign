import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ChatStorage } from "./store";
import { WorkflowAccountSelection } from "../shared/workflowInteraction";

export type AccountProvider = "claude" | "codex";
export interface AccountProfile {
  id: string;
  provider: AccountProvider;
  label: string;
  directory: string;
}
export interface AccountChoices {
  profiles: AccountProfile[];
  selected: Record<AccountProvider, string>;
}

const KEY = "countersign.cliAccounts.v1";
const DEFAULT = "default";
const MAX_PROFILES = 20;

/** Metadata only. The provider CLI owns every credential in these directories. */
export class AccountProfiles {
  private choices: AccountChoices;
  private pendingSave: Promise<void> = Promise.resolve();

  constructor(private readonly storage: ChatStorage) {
    this.choices = restore(storage.get<unknown>(KEY));
  }

  snapshot(): AccountChoices { return structuredClone(this.choices); }

  selected(provider: AccountProvider): AccountProfile | undefined {
    return this.choices.profiles.find((profile) => profile.provider === provider &&
      profile.id === this.choices.selected[provider]);
  }

  selection(labels: Partial<Record<AccountProvider, string>> = {}): WorkflowAccountSelection {
    const claude = this.selected("claude");
    const codex = this.selected("codex");
    return {
      ...(claude ? { claudeConfigDir: claude.directory } : {}),
      ...(codex ? { codexHome: codex.directory } : {}),
      claudeLabel: labels.claude ?? claude?.label ?? "Current Claude CLI login",
      codexLabel: labels.codex ?? codex?.label ?? "Current Codex CLI login",
    };
  }

  async select(provider: AccountProvider, id: string): Promise<void> {
    if (id !== DEFAULT && !this.choices.profiles.some((profile) => profile.provider === provider && profile.id === id)) {
      throw new Error("This CLI profile is no longer registered.");
    }
    this.choices.selected[provider] = id;
    await this.save();
  }

  async addExisting(provider: AccountProvider, label: string, directory: string): Promise<AccountProfile> {
    if (!isAbsolute(directory)) throw new Error("Choose an absolute CLI profile directory.");
    const canonical = await realpath(directory);
    if (!(await stat(canonical)).isDirectory()) throw new Error("The CLI profile path is not a directory.");
    return this.add(provider, label, canonical);
  }

  async create(provider: AccountProvider, label: string): Promise<AccountProfile> {
    if (this.choices.profiles.length >= MAX_PROFILES) throw new Error("Remove an older CLI profile before adding another.");
    const id = randomUUID();
    const directory = join(homedir(), ".config", "countersign", "cli-profiles", provider, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return this.add(provider, label, directory, id);
  }

  async remove(provider: AccountProvider, id: string): Promise<void> {
    if (id === DEFAULT) return;
    this.choices.profiles = this.choices.profiles.filter((entry) => entry.provider !== provider || entry.id !== id);
    if (this.choices.selected[provider] === id) this.choices.selected[provider] = DEFAULT;
    await this.save();
  }

  private async add(provider: AccountProvider, label: string, directory: string, id = randomUUID()): Promise<AccountProfile> {
    const cleaned = label.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!cleaned) throw new Error("Name this CLI account profile.");
    const duplicate = this.choices.profiles.find((entry) => entry.provider === provider && entry.directory === directory);
    if (duplicate) {
      await this.select(provider, duplicate.id);
      return duplicate;
    }
    if (this.choices.profiles.length >= MAX_PROFILES) throw new Error("Remove an older CLI profile before adding another.");
    const profile = { id, provider, label: cleaned, directory };
    this.choices.profiles.push(profile);
    this.choices.selected[provider] = id;
    await this.save();
    return profile;
  }

  private save(): Promise<void> {
    const snapshot = structuredClone(this.choices);
    this.pendingSave = this.pendingSave.catch(() => {}).then(() => this.storage.update(KEY, snapshot));
    return this.pendingSave;
  }
}

function restore(raw: unknown): AccountChoices {
  const fallback: AccountChoices = { profiles: [], selected: { claude: DEFAULT, codex: DEFAULT } };
  if (!record(raw) || !Array.isArray(raw.profiles) || !record(raw.selected)) return fallback;
  const profiles = raw.profiles.slice(0, MAX_PROFILES).filter((entry): entry is AccountProfile =>
    record(entry) && typeof entry.id === "string" && /^[0-9a-f-]{36}$/.test(entry.id) &&
    (entry.provider === "claude" || entry.provider === "codex") &&
    typeof entry.label === "string" && entry.label.length > 0 && entry.label.length <= 80 &&
    typeof entry.directory === "string" && isAbsolute(entry.directory));
  const selected = { claude: DEFAULT, codex: DEFAULT };
  for (const provider of ["claude", "codex"] as const) {
    const id = raw.selected[provider];
    if (typeof id === "string" && profiles.some((entry) => entry.provider === provider && entry.id === id)) selected[provider] = id;
  }
  return { profiles, selected };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
