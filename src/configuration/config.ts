import { LocalCheck, MockScenario } from "../shared/types";
import { FindingSeverity } from "../shared/types";

export type ImplementationProvider = "mock" | "claude";
export type CodexProviderMode = "mock" | "real";

export type WorkflowModelSelection = Pick<OrchestratorConfig,
  "claudeModel" | "claudeEffort" | "codexModel" | "codexEffort">;
export type WorkflowProviderSelection = Pick<OrchestratorConfig, "provider" | "codexProvider">;

export interface OrchestratorConfig {
  provider: ImplementationProvider;
  claudeExecutable: string;
  claudeModel: string;
  claudeEffort: string;
  codexProvider: CodexProviderMode;
  codexExecutable: string;
  codexModel: string;
  codexEffort: string;
  mockScenario: MockScenario;
  claudeAllowedTools: string[];
  localChecks: LocalCheck[];
  budgetGuardUsd: number;
  taskTimeoutMinutes: number;
  providerTimeoutMinutes: number;
  checkTimeoutMinutes: number;
  findingThreshold: FindingSeverity;
  terminationGracePeriodMs: number;
}

export const DEFAULT_CLAUDE_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write"] as const;
const ALLOWED_CLAUDE_TOOLS = new Set<string>(DEFAULT_CLAUDE_TOOLS);

type RawConfiguration = Partial<Record<keyof OrchestratorConfig, unknown>>;

export function validateConfiguration(raw: RawConfiguration): OrchestratorConfig {
  const provider = raw.provider ?? "mock";
  if (provider !== "mock" && provider !== "claude") {
    throw new Error("countersign.provider must be 'mock' or 'claude'.");
  }

  const codexProvider = raw.codexProvider ?? "mock";
  if (codexProvider !== "mock" && codexProvider !== "real") {
    throw new Error("countersign.codexProvider must be 'mock' or 'real'.");
  }
  if (provider === "claude" && codexProvider !== "real") {
    throw new Error("The real Claude implementation requires a real Codex review provider.");
  }
  const codexExecutable = raw.codexExecutable ?? "codex";
  if (typeof codexExecutable !== "string" || codexExecutable.trim().length === 0 || codexExecutable.includes("\0")) {
    throw new Error("countersign.codexExecutable must be a non-empty executable name or path.");
  }

  const claudeExecutable = raw.claudeExecutable ?? "claude";
  if (typeof claudeExecutable !== "string" || claudeExecutable.trim().length === 0 || claudeExecutable.includes("\0")) {
    throw new Error("countersign.claudeExecutable must be a non-empty executable name or path.");
  }

  const claudeModel = modelSelection(raw.claudeModel, "claudeModel");
  const claudeEffort = effortSelection(raw.claudeEffort, "claudeEffort", ["low", "medium", "high", "max"]);
  const codexModel = modelSelection(raw.codexModel, "codexModel");
  const codexEffort = effortSelection(raw.codexEffort, "codexEffort",
    ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  if (claudeEffort && !claudeModel) throw new Error("Choose a Claude model before selecting its effort.");
  if (codexEffort && !codexModel) throw new Error("Choose a Codex model before selecting its reasoning effort.");

  const scenario = raw.mockScenario ?? "clean";
  if (scenario !== "clean" && scenario !== "finding" && scenario !== "noChanges" && scenario !== "error") {
    throw new Error("countersign.mockScenario has an unsupported value.");
  }

  const rawTools = raw.claudeAllowedTools ?? [...DEFAULT_CLAUDE_TOOLS];
  if (!Array.isArray(rawTools) || !rawTools.every((tool) => typeof tool === "string")) {
    throw new Error("countersign.claudeAllowedTools must be an array of strings.");
  }
  const tools = [...new Set(rawTools as string[])];
  if (tools.some((tool) => !ALLOWED_CLAUDE_TOOLS.has(tool))) {
    throw new Error("Claude tool allowlist contains an unsupported tool. Bash and MCP tools are not allowed.");
  }

  const rawChecks = raw.localChecks ?? [];
  if (!Array.isArray(rawChecks)) {
    throw new Error("countersign.localChecks must be an array.");
  }
  const localChecks = rawChecks.map(parseLocalCheck);
  const checkIds = new Set<string>();
  for (const check of localChecks) {
    if (checkIds.has(check.id)) {
      throw new Error(`Duplicate local check id: ${check.id}`);
    }
    checkIds.add(check.id);
  }

  const findingThreshold = raw.findingThreshold ?? "High";
  if (!isFindingSeverity(findingThreshold)) {
    throw new Error("countersign.findingThreshold must be Critical, High, Medium, Low, or Info.");
  }

  return {
    provider,
    claudeExecutable,
    claudeModel,
    claudeEffort,
    codexProvider,
    codexExecutable,
    codexModel,
    codexEffort,
    mockScenario: scenario,
    claudeAllowedTools: tools,
    localChecks,
    budgetGuardUsd: boundedNumber(raw.budgetGuardUsd, 1, 0.01, 100),
    taskTimeoutMinutes: boundedNumber(raw.taskTimeoutMinutes, 30, 1, 180),
    providerTimeoutMinutes: boundedNumber(raw.providerTimeoutMinutes, 15, 1, 60),
    checkTimeoutMinutes: boundedNumber(raw.checkTimeoutMinutes, 5, 1, 30),
    findingThreshold,
    terminationGracePeriodMs: boundedNumber(raw.terminationGracePeriodMs, 1000, 100, 10_000),
  };
}

function modelSelection(value: unknown, key: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || (value !== "" && (value.length > 100 || /\s/.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32)))) {
    throw new Error(`countersign.${key} must be a model from the active provider catalog.`);
  }
  return value;
}

function effortSelection(value: unknown, key: string, levels: string[]): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || (value !== "" && !levels.includes(value))) {
    throw new Error(`countersign.${key} has an unsupported effort level.`);
  }
  return value;
}

export function isFindingSeverity(value: unknown): value is FindingSeverity {
  return value === "Critical" || value === "High" || value === "Medium" || value === "Low" || value === "Info";
}

function parseLocalCheck(value: unknown, index: number): LocalCheck {
  if (!isRecord(value)) {
    throw new Error(`Local check ${index + 1} must be an object.`);
  }
  const { id, executable, args } = value;
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
    throw new Error(`Local check ${index + 1} needs an id of 1-64 letters, digits, underscores or hyphens.`);
  }
  if (typeof executable !== "string" || executable.trim().length === 0 || executable.includes("\0")) {
    throw new Error(`Local check '${id}' needs an executable path.`);
  }
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string" && !arg.includes("\0"))) {
    throw new Error(`Arguments for local check '${id}' must be an array of strings.`);
  }
  return { id: id.trim(), executable, args: [...args] as string[] };
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = value ?? fallback;
  if (typeof number !== "number" || !Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`Configuration number must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
