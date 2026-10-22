import { OrchestratorConfig } from "../configuration/config";
import { readGitChanges } from "../context/gitChanges";
import { ProcessFailure, ProcessOptions, ProcessResult, runExecutable } from "../shared/process";
import { CLAUDE_FULL_ACCESS_REJECTED, claudeBypassRejected } from "../shared/claudePermissions";
import { AgentRequest, AgentResult, AIProvider, ClaudeGateRecord, Finding, ProviderStatus } from "../shared/types";
import { runClaudeSdkExecution, WorkflowPermissionPrompt } from "./claudeSdkExecution";

const AVAILABILITY_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1_048_576;
const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "question", "confirmed", "fixed", "remaining"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 5_000 },
    question: { type: "string", maxLength: 2_000 },
    confirmed: { type: "array", maxItems: 10, items: { type: "string" } },
    fixed: { type: "array", maxItems: 10, items: { type: "string" } },
    remaining: { type: "array", maxItems: 10, items: { type: "string" } },
  },
} as const;

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["plan", "questions"],
  properties: {
    plan: { type: "string", maxLength: 12_000 },
    questions: { type: "array", maxItems: 3, items: { type: "string", minLength: 1, maxLength: 2_000 } },
  },
} as const;

export interface ProposedPlan {
  plan: string;
  questions: string[];
  metrics?: AgentResult["metrics"];
}

export type ClaudeCliRunner = (executable: string, args: string[], options: ProcessOptions) => Promise<ProcessResult>;
export type ClaudeProviderErrorKind = "unavailable" | "capability_missing" | "gate_missing" | "authentication" | "quota" | "permissions" | "timed_out" | "cancelled" | "invalid_output" | "execution";

export class ClaudeProviderError extends Error {
  constructor(readonly kind: ClaudeProviderErrorKind, message: string) {
    super(message);
    this.name = "ClaudeProviderError";
  }
}

export interface ClaudeCliProviderOptions {
  config: OrchestratorConfig;
  gateRecord?: ClaudeGateRecord;
  runner?: ClaudeCliRunner;
  askPermission?: WorkflowPermissionPrompt;
  sdkExecution?: typeof runClaudeSdkExecution;
}

export class ClaudeCliProvider implements AIProvider {
  readonly id = "claude-cli";
  private readonly run: ClaudeCliRunner;

  constructor(private readonly options: ClaudeCliProviderOptions) {
    this.run = options.runner ?? runExecutable;
  }

  async checkAvailability(): Promise<ProviderStatus> {
    try {
      const version = await this.readVersion();
      if (!version) return { available: false, reason: "Claude CLI did not return a version." };
      if (this.options.gateRecord?.passed !== true || this.options.gateRecord.version !== version) {
        return { available: false, version, reason: "The Claude settings-source isolation gate has not passed for this exact CLI version." };
      }
      const result = await this.run(this.options.config.claudeExecutable, ["--help"], {
        cwd: process.cwd(), timeoutMs: AVAILABILITY_TIMEOUT_MS, maxOutputBytes: 131_072,
        gracePeriodMs: this.options.config.terminationGracePeriodMs,
      });
      if (result.exitCode !== 0) return { available: false, version, reason: "Claude CLI help could not be read." };
      const missing = requiredCapabilities(result.stdout);
      return missing.length === 0
        ? { available: true, version }
        : { available: false, version, reason: `Claude CLI is missing required flags: ${missing.join(", ")}.` };
    } catch {
      return { available: false, reason: "Claude CLI availability could not be verified." };
    }
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    if (request.mode === "review") throw new ClaudeProviderError("capability_missing", "Claude CLI does not perform review in this workflow.");
    if (request.signal.aborted) throw new ClaudeProviderError("cancelled", "Claude task was cancelled.");
    const version = await this.readVersion();
    if (!version || this.options.gateRecord?.version !== version || this.options.gateRecord.passed !== true) {
      throw new ClaudeProviderError("gate_missing", "Claude CLI version changed or the settings-source gate has not passed.");
    }
    const { config } = this.options;
    const fullAccess = config.executionPermission === "fullAccess";
    const args = [
      "--print", "--output-format", "json", "--json-schema", JSON.stringify(RESPONSE_SCHEMA),
      "--max-budget-usd", String(config.budgetGuardUsd),
      "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands",
      ...(fullAccess ? ["--dangerously-skip-permissions"] : ["--permission-mode", "default"]),
      "--no-session-persistence",
      "--tools", fullAccess ? "default" : config.claudeAllowedTools.join(","),
      ...(fullAccess ? [] : ["--allowedTools", config.claudeAllowedTools.join(",")]),
      ...(config.claudeModel ? ["--model", config.claudeModel] : []),
      ...(config.claudeEffort ? ["--effort", config.claudeEffort] : []),
    ];
    let result: ProcessResult;
    try {
      if (!fullAccess) {
        if (!this.options.askPermission) throw new ClaudeProviderError("permissions", "Ask before change needs a permission prompt in the chat or VS Code window.");
        result = { exitCode: 0, stderr: "", stdout: await (this.options.sdkExecution ?? runClaudeSdkExecution)(config, request,
          buildPrompt(request, true), RESPONSE_SCHEMA, this.options.askPermission) };
      } else result = await this.run(config.claudeExecutable, args, {
        cwd: request.repository,
        timeoutMs: config.providerTimeoutMinutes * 60_000,
        gracePeriodMs: config.terminationGracePeriodMs,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        signal: request.signal,
        stdin: buildPrompt(request, false),
      });
    } catch (error) {
      if (error instanceof ClaudeProviderError) throw error;
      throw mapProcessFailure(error);
    }
    if (result.exitCode !== 0) throw classifyFailure(`${result.stderr}\n${result.stdout}`, result.exitCode);
    const parsed = parseResponse(result.stdout, request.findings ?? []);
    const changes = await (request.readChanges ?? (() => readGitChanges(request.repository)))();
    if (request.mode === "correct" && parsed.fixed.length > 0 && changes.diff === request.diff) {
      throw new ClaudeProviderError("invalid_output", "Claude reported a correction but the repository diff did not change.");
    }
    return {
      changed: changes.paths.length > 0,
      changedPaths: changes.paths,
      findings: [],
      correction: request.mode === "correct" ? {
        confirmed: parsed.confirmed,
        fixed: parsed.fixed,
        remaining: parsed.remaining,
      } : undefined,
      message: parsed.summary,
      question: parsed.question || undefined,
      metrics: parsed.metrics,
    };
  }

  async proposePlan(repository: string, task: string, clarifications: { question: string; answer: string }[],
    signal: AbortSignal): Promise<ProposedPlan> {
    if (signal.aborted) throw new ClaudeProviderError("cancelled", "Planning was cancelled.");
    const version = await this.readVersion();
    if (!version || this.options.gateRecord?.version !== version || this.options.gateRecord.passed !== true) {
      throw new ClaudeProviderError("gate_missing", "Claude CLI version changed or the settings-source gate has not passed.");
    }
    const { config } = this.options;
    const readTools = "Read,Glob,Grep";
    let result: ProcessResult;
    try {
      result = await this.run(config.claudeExecutable, [
        "--print", "--output-format", "json", "--json-schema", JSON.stringify(PLAN_SCHEMA),
        "--max-budget-usd", String(config.budgetGuardUsd),
        "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands",
        "--permission-mode", "dontAsk", "--no-session-persistence",
        "--tools", readTools, "--allowedTools", readTools,
        ...(config.claudeModel ? ["--model", config.claudeModel] : []),
        ...(config.claudeEffort ? ["--effort", config.claudeEffort] : []),
      ], {
        cwd: repository, timeoutMs: config.providerTimeoutMinutes * 60_000,
        gracePeriodMs: config.terminationGracePeriodMs, maxOutputBytes: MAX_OUTPUT_BYTES,
        signal,
        stdin: [
          "Plan this task using only Read, Glob and Grep. Do not edit files, run commands, access the network or use MCP.",
          "If a missing user decision materially changes the implementation, ask up to three precise questions and leave plan empty.",
          "Otherwise return a concrete plan with files, steps and checks, and an empty questions array. Do not claim a review was performed.",
          `Task:\n${task}`,
          clarifications.length ? `User answers:\n${clarifications.map(({ question, answer }) => `Q: ${question}\nA: ${answer}`).join("\n")}` : "",
        ].filter(Boolean).join("\n\n"),
      });
    } catch (error) { throw mapProcessFailure(error); }
    if (result.exitCode !== 0) throw classifyFailure(result.stderr, result.exitCode);
    const outer = parseEnvelope(result.stdout);
    const value = outer.structured_output;
    if (!isRecord(value) || typeof value.plan !== "string" || value.plan.length > 12_000 ||
      !Array.isArray(value.questions) || value.questions.length > 3 ||
      !value.questions.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 2_000) ||
      (value.questions.length === 0 && !value.plan.trim())) {
      throw new ClaudeProviderError("invalid_output", "Claude CLI did not return a valid plan or clarification questions.");
    }
    return { plan: value.plan, questions: value.questions, metrics: envelopeMetrics(outer) };
  }

  async cancel(_taskId: string): Promise<void> {
    // AbortSignal controls the process group.
  }

  private async readVersion(): Promise<string | undefined> {
    const result = await this.run(this.options.config.claudeExecutable, ["--version"], {
      cwd: process.cwd(), timeoutMs: AVAILABILITY_TIMEOUT_MS, maxOutputBytes: 32_768,
      gracePeriodMs: this.options.config.terminationGracePeriodMs,
    });
    return result.exitCode === 0 ? result.stdout.trim().split(/\r?\n/, 1)[0] : undefined;
  }
}

export function requiredCapabilities(help: string): string[] {
  const required = ["--print", "--output-format", "--json-schema", "--max-budget-usd", "--setting-sources", "--strict-mcp-config", "--disable-slash-commands", "--tools", "--allowedTools", "--permission-mode", "--no-session-persistence"];
  return required.filter((flag) => !new RegExp(`(?:^|[\\s,])${flag}(?=[\\s,]|$)`, "m").test(help));
}

function buildPrompt(request: AgentRequest, askBeforeChange: boolean): string {
  const instructions = [
    askBeforeChange
      ? "Follow the approved plan. Ask for approval before changes, commands and network tools. Do not use MCP or plugins."
      : "Follow the approved plan. Full access was explicitly selected after plan review; commands, network and files outside the workspace are allowed when the task needs them. Do not use MCP or plugins.",
    request.changeSource === "git-snapshot"
      ? "This Git workspace already contained user changes before the task. The supplied diff starts from a file snapshot taken before planning. Preserve all earlier work, including earlier edits in the same files; make only changes required by the approved task or confirmed review findings."
      : "",
    `Report any commands, network actions or changes outside the workspace. The ${request.changeSource === "git" ? "Git diff" : "workspace snapshot diff"} only covers reviewable changes inside this workspace.`,
    `Return structured JSON matching the schema. The orchestrator computes the actual ${request.changeSource === "git" ? "Git diff" : "workspace snapshot diff"} after you finish.`,
  ];
  if (request.mode === "implement") {
    return [...instructions,
      "If a user decision is necessary before proceeding, ask one precise question in question, leave all finding arrays empty and do not edit files. Otherwise set question to an empty string and implement the task.",
      "In summary, report each changed file, what you changed, any checks you actually ran, and remaining limitations. Do not claim checks that you did not run.",
      "Implement the following task:", request.task,
      request.clarifications?.length ? `User answers:\n${JSON.stringify(request.clarifications)}` : "",
      request.diff ? `Current working-tree diff (may include changes from before this workflow; continue without discarding them):\n${request.diff}` : "",
      "Set confirmed, fixed and remaining to empty arrays."].filter(Boolean).join("\n\n");
  }
  const findings = (request.findings ?? []).map((finding, index) => ({ id: `f${index}`, ...finding }));
  return [
    ...instructions,
    "If a user decision is necessary before changing anything, ask one precise question in question, leave all finding arrays empty and do not edit files. Otherwise set question to an empty string.",
    "Re-evaluate each candidate finding against the actual code and diff. Correct only findings you confirm. Do not change code for unconfirmed findings.",
    "In summary, explain each correction and any finding left open. Do not claim checks or review turns that did not run.",
    "In confirmed, fixed and remaining return finding IDs. fixed and remaining must be disjoint subsets of confirmed. Include every confirmed ID in exactly one of fixed or remaining.",
    "Task:", request.task,
    request.clarifications?.length ? `User answers:\n${JSON.stringify(request.clarifications)}` : "",
    "Current diff:", request.diff ?? "",
    "Candidate findings:", JSON.stringify(findings),
  ].join("\n\n");
}

function parseResponse(stdout: string, candidates: Finding[]): {
  summary: string; question: string; confirmed: Finding[]; fixed: Finding[]; remaining: Finding[];
  metrics?: AgentResult["metrics"];
} {
  const outer = parseEnvelope(stdout);
  const value = outer.structured_output;
  if (!isRecord(value) || typeof value.summary !== "string" || value.summary.trim().length === 0 || value.summary.length > 5_000 ||
    typeof value.question !== "string" || value.question.length > 2_000) {
    throw new ClaudeProviderError("invalid_output", "Claude CLI did not return a valid structured response.");
  }
  const mapIds = (key: string): Finding[] => {
    const ids = value[key];
    if (!Array.isArray(ids) || ids.length > 10 || !ids.every((id) => typeof id === "string" && /^f\d+$/.test(id))) {
      throw new ClaudeProviderError("invalid_output", `Claude CLI returned invalid ${key} finding IDs.`);
    }
    if (new Set(ids).size !== ids.length) throw new ClaudeProviderError("invalid_output", `Claude CLI duplicated ${key} finding IDs.`);
    return ids.map((id) => {
      const index = Number(id.slice(1));
      if (index >= candidates.length) throw new ClaudeProviderError("invalid_output", "Claude CLI cited an unknown finding ID.");
      return candidates[index];
    });
  };
  const confirmed = mapIds("confirmed");
  const fixed = mapIds("fixed");
  const remaining = mapIds("remaining");
  const confirmedSet = new Set(confirmed);
  if (fixed.some((finding) => !confirmedSet.has(finding)) || remaining.some((finding) => !confirmedSet.has(finding))
    || fixed.some((finding) => remaining.includes(finding)) || fixed.length + remaining.length !== confirmed.length) {
    throw new ClaudeProviderError("invalid_output", "Claude CLI returned inconsistent correction findings.");
  }
  return { summary: value.summary, question: value.question, confirmed, fixed, remaining, metrics: envelopeMetrics(outer) };
}

function parseEnvelope(stdout: string): Record<string, unknown> {
  let outer: unknown;
  try { outer = JSON.parse(stdout); } catch { throw new ClaudeProviderError("invalid_output", "Claude CLI returned malformed JSON."); }
  if (!isRecord(outer)) throw new ClaudeProviderError("invalid_output", "Claude CLI returned an invalid result envelope.");
  if (outer.is_error === true) throw classifyFailure(String(outer.result ?? ""), 1);
  return outer;
}

function envelopeMetrics(outer: Record<string, unknown>): AgentResult["metrics"] {
  const usage = isRecord(outer.usage) ? outer.usage : {};
  return { estimatedCostUsd: finiteNonnegative(outer.total_cost_usd),
    inputTokens: finiteNonnegative(usage.input_tokens), outputTokens: finiteNonnegative(usage.output_tokens) };
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function mapProcessFailure(error: unknown): ClaudeProviderError {
  if (!(error instanceof ProcessFailure)) return new ClaudeProviderError("execution", "Claude CLI could not be completed.");
  if (error.kind === "cancelled") return new ClaudeProviderError("cancelled", "Claude task was cancelled.");
  if (error.kind === "timed_out") return new ClaudeProviderError("timed_out", "Claude CLI timed out.");
  if (error.kind === "spawn_error") return new ClaudeProviderError("unavailable", "Claude CLI could not be started.");
  return new ClaudeProviderError("execution", "Claude CLI exceeded the output limit.");
}

function classifyFailure(diagnostics: string, exitCode: number | null): ClaudeProviderError {
  const value = diagnostics.toLowerCase();
  if (claudeBypassRejected(diagnostics)) {
    return new ClaudeProviderError("permissions", CLAUDE_FULL_ACCESS_REJECTED);
  }
  if (/unauthori[sz]ed|not logged in|authentication|login required|invalid api key|401\b/.test(value)) {
    return new ClaudeProviderError("authentication", "Claude CLI authentication is unavailable.");
  }
  if (/quota|rate.?limit|usage limit|billing|budget|too many requests|429\b/.test(value)) {
    return new ClaudeProviderError("quota", "Claude CLI quota or budget prevented the task.");
  }
  if (/permission denied|approval required|not allowed|tool.*denied/.test(value)) {
    return new ClaudeProviderError("permissions", "Claude CLI could not use a required tool under the confirmed permission policy.");
  }
  return new ClaudeProviderError("execution", `Claude CLI failed with exit code ${String(exitCode)}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
