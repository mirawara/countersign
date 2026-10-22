import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessFailure, ProcessOptions, ProcessResult, runExecutable } from "../shared/process";
import { AgentRequest, AgentResult, AIProvider, Finding, ProviderStatus } from "../shared/types";
import { isFindingSeverity } from "../configuration/config";

const MAX_PROVIDER_OUTPUT_BYTES = 1_048_576;
const AVAILABILITY_TIMEOUT_MS = 10_000;

const REVIEW_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["summary", "question", "findings"],
  properties: {
    summary: { type: "string", maxLength: 4_000 },
    question: { type: "string", maxLength: 2_000 },
    findings: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "file", "line", "evidence", "summary"],
        properties: {
          severity: { type: "string", enum: ["Critical", "High", "Medium", "Low", "Info"] },
          file: { type: "string", minLength: 1, maxLength: 1_000 },
          line: { type: "integer", minimum: 1 },
          evidence: { type: "string", minLength: 1, maxLength: 4_000 },
          summary: { type: "string", minLength: 1, maxLength: 1_000 },
        },
      },
    },
  },
} as const;

export type CodexCliRunner = (
  executable: string,
  args: string[],
  options: ProcessOptions,
) => Promise<ProcessResult>;

export interface CodexCliProviderOptions {
  executable: string;
  model?: string;
  effort?: string;
  timeoutMs: number;
  gracePeriodMs: number;
  runner?: CodexCliRunner;
}

export type CodexProviderErrorKind =
  | "unavailable"
  | "capability_missing"
  | "authentication"
  | "quota"
  | "permissions"
  | "timed_out"
  | "cancelled"
  | "invalid_output"
  | "execution";

export class CodexProviderError extends Error {
  constructor(readonly kind: CodexProviderErrorKind, message: string) {
    super(message);
    this.name = "CodexProviderError";
  }
}

export class CodexCliProvider implements AIProvider {
  readonly id = "codex-cli";
  private readonly run: CodexCliRunner;

  constructor(private readonly options: CodexCliProviderOptions) {
    this.run = options.runner ?? runExecutable;
  }

  async checkAvailability(): Promise<ProviderStatus> {
    try {
      const versionResult = await this.run(this.options.executable, ["--version"], {
        cwd: process.cwd(),
        timeoutMs: AVAILABILITY_TIMEOUT_MS,
        gracePeriodMs: this.options.gracePeriodMs,
        maxOutputBytes: 32_768,
      });
      if (versionResult.exitCode !== 0) {
        return { available: false, reason: "Codex CLI did not return a version successfully." };
      }

      const version = versionResult.stdout.trim().split(/\r?\n/, 1)[0];
      if (!version) return { available: false, reason: "Codex CLI returned an empty version." };

      const helpResult = await this.run(this.options.executable, ["exec", "--help"], {
        cwd: process.cwd(),
        timeoutMs: AVAILABILITY_TIMEOUT_MS,
        gracePeriodMs: this.options.gracePeriodMs,
        maxOutputBytes: 65_536,
      });
      if (helpResult.exitCode !== 0) {
        return { available: false, version, reason: "Codex CLI exec help could not be read." };
      }

      const missing = requiredCapabilities(helpResult.stdout);
      if (missing.length > 0) {
        return {
          available: false,
          version,
          reason: `Codex CLI is missing required read-only review capabilities: ${missing.join(", ")}.`,
        };
      }
      return { available: true, version };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof ProcessFailure && error.kind === "spawn_error"
          ? "Codex CLI could not be started."
          : "Codex CLI availability could not be verified.",
      };
    }
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    if (request.mode !== "review") {
      throw new CodexProviderError("capability_missing", "The Codex CLI adapter supports review mode only.");
    }
    if (request.signal.aborted) {
      throw new CodexProviderError("cancelled", "Codex review was cancelled.");
    }

    const temporaryDirectory = await mkdtemp(join(tmpdir(), "countersign-codex-"));
    const schemaPath = join(temporaryDirectory, "review.schema.json");
    const messagePath = join(temporaryDirectory, "review.json");
    try {
      await writeFile(schemaPath, `${JSON.stringify(REVIEW_SCHEMA)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      const prompt = buildReviewPrompt(request);
      let result: ProcessResult;
      try {
        result = await this.run(this.options.executable, [
          "exec",
          "--sandbox", "read-only",
          "--ignore-user-config",
          "--ignore-rules",
          "--ephemeral",
          ...(request.changeSource === "snapshot" ? ["--skip-git-repo-check"] : []),
          ...(this.options.model ? ["--model", this.options.model] : []),
          ...(this.options.effort ? ["--config", `model_reasoning_effort="${this.options.effort}"`] : []),
          "--json",
          "--output-schema", schemaPath,
          "--output-last-message", messagePath,
          "-",
        ], {
          cwd: request.repository,
          timeoutMs: this.options.timeoutMs,
          gracePeriodMs: this.options.gracePeriodMs,
          maxOutputBytes: MAX_PROVIDER_OUTPUT_BYTES,
          signal: request.signal,
          stdin: prompt,
        });
      } catch (error) {
        throw mapProcessFailure(error);
      }

      if (result.exitCode !== 0) {
        throw classifyExecutionFailure(result.stderr, result.exitCode);
      }
      const metrics = requireCompletedJsonlEvent(result.stdout);

      let message: string;
      try {
        const messageStat = await stat(messagePath);
        if (messageStat.size === 0 || messageStat.size > MAX_PROVIDER_OUTPUT_BYTES) {
          throw new Error("Last-message file has an invalid size.");
        }
        message = await readFile(messagePath, "utf8");
      } catch {
        throw new CodexProviderError("invalid_output", "Codex CLI did not produce a valid structured review result.");
      }

      const parsed = parseReviewResult(message);
      return { changed: false, findings: parsed.findings, message: parsed.summary,
        question: parsed.question || undefined, ...(metrics ? { metrics } : {}) };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async cancel(_taskId: string): Promise<void> {
    // The request AbortSignal owns the process lifetime and terminates its process group.
  }
}

function requiredCapabilities(help: string): string[] {
  const required = [
    "--sandbox",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--output-schema",
    "--output-last-message",
    "--json",
  ];
  const missing = required.filter((flag) => !hasOption(help, flag));
  const sandboxStart = help.indexOf("--sandbox");
  const sandboxTail = sandboxStart < 0 ? "" : help.slice(sandboxStart);
  const nextOption = sandboxTail.slice(1).search(/\n\s{2,}--/);
  const sandboxBlock = nextOption < 0 ? sandboxTail : sandboxTail.slice(0, nextOption + 1);
  const sandboxModes = sandboxBlock.match(/\[possible values:([^\]]+)\]/)?.[1] ?? "";
  if (!/(?:^|[,\s])read-only(?:$|[,\s])/.test(sandboxModes)) missing.push("--sandbox read-only");
  if (!/instructions are read from stdin/i.test(help) || !/if `-` is used/i.test(help)) {
    missing.push("stdin prompt via -");
  }
  return missing;
}

function hasOption(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s,])${escaped}(?=[\\s,]|$)`, "m").test(help);
}

function buildReviewPrompt(request: AgentRequest): string {
  const simulated = request.diff === undefined;
  return [
    simulated
      ? "Perform a read-only code review of the simulated change below, using repository files only as context."
      : "Perform a read-only code review of the actual workspace change below, using workspace files as context.",
    "Do not edit files, run commands that mutate state or access the network, or attempt to correct findings.",
    `Report only actionable findings caused by this ${simulated ? "simulated" : "actual"} change. Do not report unrelated pre-existing issues.`,
    "For each finding, use a changed file path and line number, cite concrete evidence, and choose a severity.",
    "If a user decision is necessary to complete the review, return one precise question and an empty findings array. Otherwise set question to an empty string.",
    "Return the required structured JSON with a concise summary and findings array.",
    "",
    "Task:",
    request.task,
    request.clarifications?.length ? `User answers:\n${JSON.stringify(request.clarifications)}` : "",
    request.implementationSummary ? `Claude's report of what it did (unverified; check against the actual files and diff):\n${request.implementationSummary.slice(0, 5_000)}` : "",
    request.preExistingPaths?.length ? `Git status entries present before this workflow (these paths are excluded from this review diff):\n${request.preExistingPaths.join("\n")}` : "",
    "",
    simulated ? "Simulated diff (it exists only in memory and is not applied to the workspace):" : `Actual ${request.changeSource === "git" ? "Git" : "workspace snapshot"} diff:`,
    request.diff ?? request.simulatedDiff ?? "(no diff supplied)",
  ].join("\n");
}

function requireCompletedJsonlEvent(stdout: string): AgentResult["metrics"] {
  let completed: Record<string, unknown> | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (isRecord(event) && event.type === "turn.failed") {
        throw new CodexProviderError("execution", "Codex CLI reported a failed review turn.");
      }
      if (isRecord(event) && event.type === "turn.completed") completed = event;
    } catch (error) {
      if (error instanceof CodexProviderError) throw error;
      // The final result is read from --output-last-message; CLI banners are not review data.
    }
  }
  if (!completed) throw new CodexProviderError("invalid_output", "Codex CLI returned no completed JSONL review turn.");
  const usage = isRecord(completed.usage) ? completed.usage : undefined;
  if (!usage) return undefined;
  const inputTokens = finiteNonnegative(usage.input_tokens);
  const outputTokens = finiteNonnegative(usage.output_tokens);
  return inputTokens === undefined && outputTokens === undefined ? undefined : { inputTokens, outputTokens };
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseReviewResult(text: string): { summary: string; question: string; findings: Finding[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CodexProviderError("invalid_output", "Codex CLI returned a malformed structured review result.");
  }
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["summary", "question", "findings"])
    || typeof value.summary !== "string" || value.summary.length > 4_000
    || typeof value.question !== "string" || value.question.length > 2_000
    || !Array.isArray(value.findings)) {
    throw new CodexProviderError("invalid_output", "Codex CLI review result did not match the required schema.");
  }

  const findings: Finding[] = [];
  for (const item of value.findings) {
    if (!isRecord(item)
      || !hasOnlyKeys(item, ["severity", "file", "line", "evidence", "summary"])
      || !isFindingSeverity(item.severity)
      || typeof item.file !== "string" || item.file.length === 0 || item.file.length > 1_000 || item.file.includes("\0")
      || typeof item.line !== "number" || !Number.isInteger(item.line) || item.line < 1
      || typeof item.evidence !== "string" || item.evidence.trim().length === 0 || item.evidence.length > 4_000
      || typeof item.summary !== "string" || item.summary.trim().length === 0 || item.summary.length > 1_000) {
      throw new CodexProviderError("invalid_output", "Codex CLI returned a finding that did not match the required schema.");
    }
    findings.push({
      severity: item.severity,
      file: item.file,
      line: item.line,
      evidence: item.evidence,
      summary: item.summary,
    });
  }
  if (findings.length > 100) {
    throw new CodexProviderError("invalid_output", "Codex CLI returned too many review findings.");
  }
  return { summary: value.summary, question: value.question, findings };
}

function mapProcessFailure(error: unknown): CodexProviderError {
  if (!(error instanceof ProcessFailure)) {
    return new CodexProviderError("execution", "Codex CLI review could not be completed.");
  }
  if (error.kind === "timed_out") return new CodexProviderError("timed_out", "Codex CLI review timed out.");
  if (error.kind === "cancelled") return new CodexProviderError("cancelled", "Codex CLI review was cancelled.");
  if (error.kind === "spawn_error") return new CodexProviderError("unavailable", "Codex CLI could not be started.");
  return new CodexProviderError("execution", "Codex CLI review exceeded the output limit.");
}

function classifyExecutionFailure(diagnostics: string, exitCode: number | null): CodexProviderError {
  const message = diagnostics.toLowerCase();
  if (/unauthori[sz]ed|not logged in|authentication|login required|invalid api key|401\b/.test(message)) {
    return new CodexProviderError("authentication", "Codex authentication is unavailable. Sign in to Codex CLI and try again.");
  }
  if (/quota|rate.?limit|usage limit|billing|too many requests|429\b/.test(message)) {
    return new CodexProviderError("quota", "Codex account quota or rate limit prevented the review.");
  }
  if (/permission denied|approval required|sandbox.*denied|operation not permitted/.test(message)) {
    return new CodexProviderError("permissions", "Codex CLI could not complete the read-only review under its sandbox policy.");
  }
  if (/network|connection|could not resolve|timed? ?out|server error|503\b|502\b/.test(message)) {
    return new CodexProviderError("unavailable", "Codex service or network is unavailable.");
  }
  return new CodexProviderError("execution", `Codex CLI review failed with exit code ${String(exitCode)}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}
