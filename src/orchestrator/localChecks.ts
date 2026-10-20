import { CheckResult, LocalCheck } from "../shared/types";
import { ProcessFailure, runExecutable } from "../shared/process";

export async function runLocalChecks(
  checks: LocalCheck[],
  repository: string,
  timeoutMs: number,
  gracePeriodMs: number,
  signal: AbortSignal,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    if (signal.aborted) throw new ProcessFailure("cancelled", "Workflow cancelled before local checks completed.");
    try {
      const result = await runExecutable(check.executable, check.args, {
        cwd: repository,
        timeoutMs,
        gracePeriodMs,
        signal,
      });
      results.push({
        id: check.id,
        passed: result.exitCode === 0,
        exitCode: result.exitCode,
        output: result.stdout + result.stderr,
        timedOut: false,
      });
    } catch (error) {
      if (!(error instanceof ProcessFailure)) throw error;
      if (error.kind === "cancelled") throw error;
      results.push({
        id: check.id,
        passed: false,
        exitCode: null,
        output: error.output || error.message,
        timedOut: error.kind === "timed_out",
      });
    }
  }
  return results;
}
