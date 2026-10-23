import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runStrictTask, startingWork } from "../src/orchestrator/strictTask";
import { readStrictGit } from "../src/context/strictGit";
import { createStrictWorkspaceChanges, StrictWorkspace } from "../src/context/strictWorkspace";
import { resolveStrictLimits } from "../src/shared/strictLimits";
import {
  StrictPlanningCapability, StrictPlanningProvider, StrictPlanProviderReply, StrictSessionCapability,
} from "../src/orchestrator/strictProviders";
import { StrictMarkerStorage, StrictMarkerStore } from "../src/shared/strictMarker";
import { detailedWorkflowReport } from "../src/orchestrator/report";
import { StrictWorkflowResult } from "../src/shared/strict";
import { StrictWorkflowEvent } from "../src/shared/types";

const folders: string[] = [];
afterEach(async () => Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))));

class MemoryStorage implements StrictMarkerStorage {
  private readonly data = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, structuredClone(value));
  }
}

function planningProvider(kind: "claude" | "codex", capability: Partial<StrictPlanningCapability> = {}): StrictPlanningProvider {
  return {
    id: `${kind}-fake`,
    kind,
    checkPlanningCapability: async () => ({
      available: true, readOnlyToolsEnforced: true, freshContext: true, providerVersion: "1.0", ...capability,
    }),
    request: async (): Promise<StrictPlanProviderReply> => { throw new Error("no request expected"); },
    cancel: async () => undefined,
  };
}

const unusedImplementation = {
  id: "claude-fake",
  kind: "claude" as const,
  checkSessionCapability: async (): Promise<StrictSessionCapability> => ({
    available: true, freshContext: true, readOnlySandbox: true,
  }),
  implement: async () => { throw new Error("phase B must not start"); },
  approveSnapshot: async () => { throw new Error("phase B must not start"); },
  cancel: async () => undefined,
};

const unusedReview = {
  id: "codex-fake",
  kind: "codex" as const,
  checkSessionCapability: async (): Promise<StrictSessionCapability> => ({
    available: true, freshContext: true, readOnlySandbox: true,
  }),
  review: async () => { throw new Error("phase B must not start"); },
  cancel: async () => undefined,
};

async function run(options: {
  storage: StrictMarkerStorage;
  hostId?: string;
  capability?: Partial<StrictPlanningCapability>;
}): Promise<{ state: string; reasonCode?: string; events: StrictWorkflowEvent[]; stored: unknown }> {
  const repository = await mkdtemp(join(tmpdir(), "countersign-strict-task-"));
  folders.push(repository);
  await writeFile(join(repository, "src.ts"), "export const value = 1;\n");
  const events: StrictWorkflowEvent[] = [];
  const result = await runStrictTask({
    repository,
    task: "Add the parser",
    localChecks: [],
    planningClaude: planningProvider("claude", options.capability),
    planningCodex: planningProvider("codex"),
    implementationClaude: unusedImplementation,
    reviewCodex: unusedReview,
    human: {
      askQuestion: async () => undefined,
      requestApproval: async () => ({ kind: "refuse" }),
    },
    pause: { onPause: async () => "stop" },
    runChecks: async () => [],
    markers: new StrictMarkerStore(options.storage, options.hostId ?? "host-a"),
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  });
  return {
    state: result.state,
    reasonCode: result.reason?.code,
    events,
    stored: options.storage.get("countersign.strict-interruption.v1"),
  };
}

describe("Strict task lifecycle", () => {
  it("writes the active marker before the first provider request, which is in phase A", async () => {
    const storage = new MemoryStorage();
    const seen: unknown[] = [];
    const tracking: StrictMarkerStorage = {
      get: (key) => storage.get(key),
      update: async (key, value) => {
        seen.push(structuredClone(value));
        await storage.update(key, value);
      },
    };
    // Codex cannot prove read-only planning tools, so phase A stops at its capability gate:
    // the marker must already be active by then.
    const result = await run({ storage: tracking, capability: { readOnlyToolsEnforced: false } });

    expect(result.state).toBe("blocked_permissions");
    expect(result.reasonCode).toBe("planning_tools_not_read_only");
    expect(seen[0]).toMatchObject({ outcome: "active", hostId: "host-a", mode: "strict" });
    // A deterministic conclusion clears the marker; only an interruption leaves one behind.
    expect(result.stored).toBeUndefined();
  });

  it("lists the work already in the repository when the task starts", async () => {
    const repository = await mkdtemp(join(tmpdir(), "countersign-strict-task-"));
    folders.push(repository);
    await writeFile(join(repository, "src.ts"), "export const value = 1;\n");
    const git = (...args: string[]): void => void execFileSync("git", args, { cwd: repository, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.name", "Countersign tests");
    git("config", "user.email", "countersign-tests@example.invalid");
    git("add", "-A");
    git("commit", "-qm", "baseline");
    // Uncommitted work that the Strict baseline contains: comparing the baseline with
    // itself would report this repository as clean.
    await writeFile(join(repository, "src.ts"), "export const value = 2;\n");
    await writeFile(join(repository, "untracked.ts"), "export const extra = 1;\n");

    const storage = new MemoryStorage();
    const result = await runStrictTask({
      repository,
      task: "Add the parser",
      localChecks: [],
      planningClaude: planningProvider("claude", { readOnlyToolsEnforced: false }),
      planningCodex: planningProvider("codex"),
      implementationClaude: unusedImplementation,
      reviewCodex: unusedReview,
      human: { askQuestion: async () => undefined, requestApproval: async () => ({ kind: "refuse" }) },
      pause: { onPause: async () => "stop" },
      runChecks: async () => [],
      markers: new StrictMarkerStore(storage, "host-a"),
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });

    expect(result.preExistingEntries.join("\n")).toContain("src.ts");
    expect(result.preExistingEntries.join("\n")).toContain("untracked.ts");
  });

  it("says so when the folder has no Git repository at all", async () => {
    const repository = await mkdtemp(join(tmpdir(), "countersign-strict-task-"));
    folders.push(repository);
    await writeFile(join(repository, "src.ts"), "export const value = 1;\n");
    const result = await runTaskWith(repository);

    expect(result.preExistingStatus).toBe("no_repository");
    expect(detailedWorkflowReport(result)).toContain("cannot revert anything here");
  });

  it("returns a cancelled result when the task is cancelled on its way in", async () => {
    const repository = await mkdtemp(join(tmpdir(), "countersign-strict-task-"));
    folders.push(repository);
    await writeFile(join(repository, "src.ts"), "export const value = 1;\n");
    const git = (...args: string[]): void => void execFileSync("git", args, { cwd: repository, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.name", "Countersign tests");
    git("config", "user.email", "countersign-tests@example.invalid");
    git("add", "-A");
    git("commit", "-qm", "baseline");

    const controller = new AbortController();
    const storage = new MemoryStorage();
    const result = await runStrictTask({
      repository,
      task: "Add the parser",
      localChecks: [],
      // Cancelling while the baseline is being taken: what follows must report the task
      // as cancelled, not as an internal error.
      planningClaude: planningProvider("claude"),
      planningCodex: planningProvider("codex"),
      implementationClaude: unusedImplementation,
      reviewCodex: unusedReview,
      human: { askQuestion: async () => undefined, requestApproval: async () => ({ kind: "refuse" }) },
      pause: { onPause: async () => "stop" },
      runChecks: async () => [],
      markers: new StrictMarkerStore(storage, "host-a"),
      signal: controller.signal,
      onEvent: () => controller.abort(),
    });

    expect(["cancelled"]).toContain(result.state);
    expect(result.reason?.code).toBe("cancelled");
  });

  it("does not claim a clean tree when it never looked", async () => {
    const storage = new MemoryStorage();
    await storage.update("countersign.strict-interruption.v1", {
      id: "other", hostId: "another-window", mode: "strict",
      timestamp: new Date().toISOString(), outcome: "active",
    });
    const repository = await mkdtemp(join(tmpdir(), "countersign-strict-task-"));
    folders.push(repository);
    await writeFile(join(repository, "src.ts"), "export const value = 1;\n");
    const result = await runTaskWith(repository, undefined, storage);

    // The task stopped on the foreign marker, before any workspace reading.
    expect(result.preExistingStatus).toBeUndefined();
    const report = detailedWorkflowReport(result);
    // Nothing was planned, reviewed or approved, so the report is the short preflight one
    // and it claims nothing at all about the working tree.
    expect(report).toContain("# Strict preflight report");
    expect(report).toContain("Phase A (plan agreement): not started.");
    expect(report).not.toContain("Git reported a clean tree");
    expect(report).not.toContain("## Changes already present before this task");
  });

  it("reaches phase A over a perimeter larger than 64 MiB", async () => {
    const repository = await mkdtemp(join(tmpdir(), "countersign-strict-task-"));
    folders.push(repository);
    // 80 MiB of included files: the size of the perimeter must not keep the task from
    // ever contacting a provider.
    for (let index = 0; index < 20; index++) {
      await writeFile(join(repository, `blob-${index}.bin`), Buffer.alloc(4 * 1024 * 1024, index));
    }
    await writeFile(join(repository, "src.ts"), "export const value = 1;\n");

    const result = await runTaskWith(repository);

    // Phase A started and stopped at its own capability gate, not at a scan ceiling.
    expect(result.state).toBe("blocked_permissions");
    expect(result.reason?.code).toBe("planning_tools_not_read_only");
    expect(result.limitBreaches).toEqual([]);
    expect(result.baseline?.entryCount).toBe(21);
    expect(detailedWorkflowReport(result)).not.toContain("# Strict preflight report");
  }, 60_000);

  it("reports a cancellation that lands during the Git read as a cancelled task", async () => {
    const repository = await mkdtemp(join(tmpdir(), "countersign-strict-task-"));
    folders.push(repository);
    await writeFile(join(repository, "src.ts"), "export const value = 1;\n");
    execFileSync("git", ["init", "-q"], { cwd: repository, stdio: "ignore" });

    // Live through the scan, cancelled once a process has started: the scan spawns
    // nothing, so the first Git command is what flips it.
    let started = 0;
    const signal = {
      get aborted(): boolean {
        return started > 0;
      },
      addEventListener: (): void => { started += 1; },
      removeEventListener: (): void => undefined,
    } as unknown as AbortSignal;

    const storage = new MemoryStorage();
    const result = await runStrictTask({
      repository,
      task: "Add the parser",
      localChecks: [],
      planningClaude: planningProvider("claude"),
      planningCodex: planningProvider("codex"),
      implementationClaude: unusedImplementation,
      reviewCodex: unusedReview,
      human: { askQuestion: async () => undefined, requestApproval: async () => ({ kind: "refuse" }) },
      pause: { onPause: async () => "stop" },
      runChecks: async () => [],
      markers: new StrictMarkerStore(storage, "host-a"),
      signal,
      onEvent: () => undefined,
    });

    expect(started).toBeGreaterThan(0);
    expect(result.state).toBe("cancelled");
    expect(result.reason?.code).toBe("cancelled");
    // Nothing was written to the marker: no provider request was ever made.
    expect(storage.get("countersign.strict-interruption.v1")).toBeUndefined();
  });

  it("refuses to start while a marker this window does not own is stored", async () => {
    const storage = new MemoryStorage();
    await storage.update("countersign.strict-interruption.v1", {
      id: "other-task", hostId: "another-window", mode: "strict",
      timestamp: new Date().toISOString(), outcome: "active",
    });
    const result = await run({ storage, hostId: "host-b" });

    expect(result.state).toBe("failed");
    expect(result.reasonCode).toBe("marker_conflict");
    expect(result.events).toHaveLength(0);
    expect(result.stored).toMatchObject({ hostId: "another-window" });
  });

  it("refuses to start on a marker that does not match the schema", async () => {
    const storage = new MemoryStorage();
    await storage.update("countersign.strict-interruption.v1", { id: "x", mode: "strict" });
    const result = await run({ storage });

    expect(result.state).toBe("failed");
    expect(result.stored).toMatchObject({ id: "x" });
  });
});

/** Runs a task that stops at the phase A capability gate, after an optional interference. */
async function runTaskWith(
  repository: string,
  interfere?: () => Promise<void>,
  storage: StrictMarkerStorage = new MemoryStorage(),
): Promise<StrictWorkflowResult> {
  return runStrictTask({
    repository,
    task: "Add the parser",
    localChecks: [],
    planningClaude: {
      id: "claude-fake",
      kind: "claude",
      checkPlanningCapability: async () => {
        await interfere?.();
        return { available: true, readOnlyToolsEnforced: false, freshContext: true, providerVersion: "1.0" };
      },
      request: async () => { throw new Error("no request expected"); },
      cancel: async () => undefined,
    },
    planningCodex: planningProvider("codex"),
    implementationClaude: unusedImplementation,
    reviewCodex: unusedReview,
    human: { askQuestion: async () => undefined, requestApproval: async () => ({ kind: "refuse" }) },
    pause: { onPause: async () => "stop" },
    runChecks: async () => [],
    markers: new StrictMarkerStore(storage, "host-a"),
    signal: new AbortController().signal,
    onEvent: () => undefined,
  });
}

describe("work already in the repository", () => {
  async function workspaceFor(options: { git: boolean; breakAfterBaseline?: boolean }): Promise<StrictWorkspace> {
    const root = await mkdtemp(join(tmpdir(), "countersign-starting-"));
    folders.push(root);
    await writeFile(join(root, "src.ts"), "export const value = 1;\n");
    if (options.git) {
      const git = (...args: string[]): void => void execFileSync("git", args, { cwd: root, stdio: "ignore" });
      git("init", "-q");
      git("config", "user.name", "Countersign tests");
      git("config", "user.email", "countersign-tests@example.invalid");
      git("add", "-A");
      git("commit", "-qm", "baseline");
      await writeFile(join(root, "src.ts"), "export const value = 2;\n");
    }
    if (options.breakAfterBaseline) {
      // Git is readable when the baseline is taken and broken immediately after; the
      // answer belongs to the moment the task started.
      const created = await createStrictWorkspaceChanges({ folder: root, limits: resolveStrictLimits() });
      if (!created.ok) throw new Error(created.failure.message);
      await rm(join(root, ".git"), { recursive: true, force: true });
      return created.workspace;
    }
    const created = await createStrictWorkspaceChanges({ folder: root, limits: resolveStrictLimits() });
    if (!created.ok) throw new Error(created.failure.message);
    return created.workspace;
  }

  it("lists what Git reported as already changed", async () => {
    const workspace = await workspaceFor({ git: true });
    const work = startingWork(workspace);
    expect(work.kind).toBe("git");
    expect(work.kind === "git" && work.entries.join("\n")).toContain("src.ts");
    await workspace.close();
  });

  it("separates a folder without Git from a repository read at baseline time", async () => {
    const withoutGit = await workspaceFor({ git: false });
    expect(startingWork(withoutGit).kind).toBe("no_repository");
    await withoutGit.close();

    // Breaking Git after the baseline does not rewrite what was already recorded.
    const broken = await workspaceFor({ git: true, breakAfterBaseline: true });
    expect(startingWork(broken).kind).toBe("git");
    await broken.close();
  });

  it("reports an unreadable Git as unavailable, not as a clean tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-starting-"));
    folders.push(root);
    await writeFile(join(root, "src.ts"), "export const value = 1;\n");
    const git = (...args: string[]): void => void execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    // A repository whose index is a directory: rev-parse answers, status cannot.
    await rm(join(root, ".git", "index"), { force: true });
    await mkdir(join(root, ".git", "index"), { recursive: true });
    const created = await createStrictWorkspaceChanges({ folder: root, limits: resolveStrictLimits() });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(startingWork(created.workspace).kind).toBe("unavailable");
    await created.workspace.close();
  });

  it("keeps Git bound to the opened repository when the root path is replaced", async () => {
    const stage = await mkdtemp(join(tmpdir(), "countersign-gitboundary-"));
    folders.push(stage);
    const root = join(stage, "repo");
    const decoy = join(stage, "decoy");
    await mkdir(root, { recursive: true });
    await mkdir(decoy, { recursive: true });
    const run = (cwd: string, ...args: string[]): void => void execFileSync("git", args, { cwd, stdio: "ignore" });
    for (const [folder, file, content] of [[root, "original.ts", "ORIGINAL\n"], [decoy, "planted.ts", "DECOY\n"]] as const) {
      await writeFile(join(folder, file), content);
      run(folder, "init", "-q");
      run(folder, "config", "user.name", "Countersign tests");
      run(folder, "config", "user.email", "countersign-tests@example.invalid");
      run(folder, "add", "-A");
      run(folder, "commit", "-qm", "baseline");
    }
    // Both repositories have uncommitted work, so an empty answer cannot pass for either.
    await writeFile(join(root, "original.ts", ), "ORIGINAL CHANGED\n");
    await writeFile(join(decoy, "planted.ts"), "DECOY CHANGED\n");

    const created = await createStrictWorkspaceChanges({ folder: root, limits: resolveStrictLimits() });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await rename(root, join(stage, "repo-aside"));
    folders.push(join(stage, "repo-aside"));
    await rename(decoy, root);

    // Read now, with the path pointing at the decoy: status and HEAD still answer for the
    // repository the descriptor holds.
    const reading = await readStrictGit(created.workspace.pinnedRoot, rootIdentityOf(created.workspace), undefined);
    expect(reading.kind).toBe("repository");
    if (reading.kind !== "repository") return;
    expect(reading.dirtyEntries.join("\n")).toContain("original.ts");
    expect(reading.dirtyEntries.join("\n")).not.toContain("planted.ts");
    expect(reading.repository).toBe(join(stage, "repo-aside"));
    expect(reading.head).toMatch(/^[0-9a-f]{7,40}$/);
    await created.workspace.close();
  });
});

/** The identity the workspace pinned, read back through its own descriptor. */
function rootIdentityOf(workspace: StrictWorkspace): { ino: number; dev: number } {
  const stats = statSync(workspace.pinnedRoot);
  return { ino: stats.ino, dev: stats.dev };
}
