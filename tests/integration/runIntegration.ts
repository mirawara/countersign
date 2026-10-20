import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

const EXTENSION_ROOT = resolve(__dirname, "..", "..", "..");
const INTEGRATION_DIST = resolve(__dirname, "..", "..");
const SUITE_PATH = resolve(__dirname, "suite", "index.js");
const SYSTEM_VSCODE = "/usr/share/code/code";

interface IntegrationCase {
  name: string;
  fixture: string;
  settings: Record<string, unknown>;
  timeoutMs: number;
  /** Real cases issue provider requests and only run when consent is passed explicitly. */
  real?: boolean;
}

const MOCK_BASE = {
  "countersign.provider": "mock",
  "countersign.codexProvider": "mock",
  "countersign.findingThreshold": "High",
};

const CASES: IntegrationCase[] = [
  {
    name: "mock-clean",
    fixture: "mock-repo",
    timeoutMs: 180_000,
    settings: {
      ...MOCK_BASE,
      "countersign.mockScenario": "clean",
      "countersign.localChecks": [
        { id: "marker", executable: "node", args: ["-e", "console.log('AIDO_CHECK_MARKER_7391')"] },
      ],
    },
  },
  {
    name: "mock-finding",
    fixture: "mock-repo",
    timeoutMs: 180_000,
    settings: { ...MOCK_BASE, "countersign.mockScenario": "finding", "countersign.localChecks": [] },
  },
  {
    name: "mock-dismiss",
    fixture: "mock-repo",
    timeoutMs: 180_000,
    settings: { ...MOCK_BASE, "countersign.mockScenario": "clean", "countersign.localChecks": [] },
  },
  {
    name: "mock-validation-failed",
    fixture: "mock-repo",
    timeoutMs: 180_000,
    settings: {
      ...MOCK_BASE,
      "countersign.mockScenario": "clean",
      "countersign.localChecks": [
        { id: "failing", executable: "node", args: ["-e", "process.exit(3)"] },
      ],
    },
  },
  {
    name: "cancel-during-check",
    fixture: "cancel-repo",
    timeoutMs: 300_000,
    settings: {
      ...MOCK_BASE,
      "countersign.mockScenario": "clean",
      "countersign.checkTimeoutMinutes": 10,
      "countersign.localChecks": [{ id: "slow-check", executable: "node", args: ["slow-check.js"] }],
    },
  },
  {
    name: "real-workflow",
    fixture: "real-repo",
    timeoutMs: 1_800_000,
    real: true,
    settings: {
      "countersign.provider": "claude",
      "countersign.codexProvider": "real",
      "countersign.claudeExecutable": "claude",
      "countersign.codexExecutable": "codex",
      "countersign.claudeAllowedTools": ["Read", "Glob", "Grep", "Edit", "Write"],
      "countersign.budgetGuardUsd": 1,
      "countersign.findingThreshold": "High",
      "countersign.localChecks": [{ id: "node-tests", executable: "node", args: ["--test"] }],
    },
  },
];

interface Options {
  only: string[];
  fixturesRoot: string;
  workRoot: string;
  consentReal: boolean;
  /** When set, the installed VSIX in this extensions directory is tested instead of the sources. */
  extensionsDir?: string;
}

function parseOptions(argv: string[]): Options {
  const value = (flag: string): string | undefined =>
    argv.find((argument) => argument.startsWith(`${flag}=`))?.slice(flag.length + 1);
  const fixturesRoot = value("--fixtures");
  const workRoot = value("--work");
  if (!fixturesRoot || !workRoot) {
    throw new Error("Usage: runIntegration --fixtures=<dir> --work=<dir> [--only=a,b] [--real] [--packaged=<extensionsDir>]");
  }
  return {
    only: (value("--only") ?? "").split(",").filter(Boolean),
    fixturesRoot: resolve(fixturesRoot),
    workRoot: resolve(workRoot),
    consentReal: argv.includes("--real"),
    extensionsDir: value("--packaged"),
  };
}

/**
 * Drops the Electron and VS Code variables this process inherits when the runner itself is
 * started from inside VS Code. Left in place, ELECTRON_RUN_AS_NODE makes the launched binary
 * behave as Node and treat the workspace path as a module to require.
 */
function cleanEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name === "ELECTRON_RUN_AS_NODE" || name.startsWith("VSCODE_") || name === "NODE_OPTIONS") continue;
    env[name] = value;
  }
  return env;
}

function git(repository: string, args: string[]): void {
  execFileSync("git", args, { cwd: repository, stdio: "pipe" });
}

/** Returns each fixture to its committed state so cases never inherit another case's changes. */
function resetFixture(repository: string): void {
  git(repository, ["reset", "--hard", "HEAD"]);
  git(repository, ["clean", "-fd"]);
}

function writeSettings(repository: string, settings: Record<string, unknown>): void {
  const directory = join(repository, ".vscode");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

/** Locates the extracted extension inside an isolated profile's extensions directory. */
function installedExtensionPath(extensionsDir: string): string {
  const root = resolve(extensionsDir);
  const entry = readdirSync(root, { withFileTypes: true })
    .find((candidate) => candidate.isDirectory() && candidate.name.startsWith("local.countersign-"));
  if (!entry) throw new Error(`No installed countersign extension found in ${root}.`);
  return join(root, entry.name);
}

async function resolveVSCode(): Promise<string> {
  if (existsSync(SYSTEM_VSCODE)) return SYSTEM_VSCODE;
  return downloadAndUnzipVSCode();
}

interface CaseOutcome {
  name: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  error?: string;
  report?: unknown;
  logPath: string;
}

async function runCase(
  testCase: IntegrationCase,
  options: Options,
  executable: string,
): Promise<CaseOutcome> {
  const repository = join(options.fixturesRoot, testCase.fixture);
  const caseWork = join(options.workRoot, testCase.name);
  rmSync(caseWork, { recursive: true, force: true });
  mkdirSync(caseWork, { recursive: true });
  const resultFile = join(caseWork, "result.json");
  const logPath = join(caseWork, "vscode.log");
  const userDataDir = join(caseWork, "user-data");

  resetFixture(repository);
  writeSettings(repository, testCase.settings);

  // VS Code runs --extensionTestsPath only in extension-development mode, and only for a path
  // inside the development extension; it also runs it only alongside --disable-extensions, which
  // would disable an extension installed in the profile. A packaged run therefore loads a copy of
  // the installed package through the development path, with the compiled suite placed beside it.
  // That exercises the packaged dist and manifest, including activation and command registration,
  // but not VS Code's ordinary resolution of an installed extension.
  let extensionPath = EXTENSION_ROOT;
  let suitePath = SUITE_PATH;
  const extensionsDir = join(caseWork, "extensions");
  mkdirSync(extensionsDir, { recursive: true });
  if (options.extensionsDir) {
    extensionPath = join(caseWork, "extension-under-test");
    cpSync(installedExtensionPath(options.extensionsDir), extensionPath, { recursive: true });
    cpSync(INTEGRATION_DIST, join(extensionPath, ".integration-dist"), { recursive: true });
    suitePath = join(extensionPath, ".integration-dist", "tests", "integration", "suite", "index.js");
  }

  const launchArgs = [
    repository,
    `--user-data-dir=${userDataDir}`,
    `--extensionTestsPath=${suitePath}`,
    `--extensions-dir=${extensionsDir}`,
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-updates",
    "--no-sandbox",
    "--disable-gpu-sandbox",
  ];
  launchArgs.push(`--extensionDevelopmentPath=${extensionPath}`, "--disable-extensions");

  const started = Date.now();
  const exitCode = await new Promise<number | null>((resolveExit) => {
    const child = spawn(executable, launchArgs, {
      env: {
        ...cleanEnvironment(),
        AIDO_CASE: testCase.name,
        AIDO_RESULT_FILE: resultFile,
        ELECTRON_NO_ATTACH_CONSOLE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    const collect = (chunk: Buffer): void => { log += chunk.toString("utf8"); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      log += `\n[runner] Timed out after ${testCase.timeoutMs} ms; terminating VS Code.\n`;
      child.kill("SIGKILL");
    }, testCase.timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      writeFileSync(logPath, log);
      resolveExit(code);
    });
  });

  let parsed: { passed?: boolean; error?: string; report?: unknown } | undefined;
  if (existsSync(resultFile)) {
    parsed = JSON.parse(readFileSync(resultFile, "utf8")) as typeof parsed;
  }
  const outcome: CaseOutcome = {
    name: testCase.name,
    passed: parsed?.passed === true && exitCode === 0,
    exitCode,
    durationMs: Date.now() - started,
    error: parsed?.error ?? (parsed ? undefined : "The test suite wrote no result file."),
    report: parsed?.report,
    logPath,
  };
  if (!testCase.real) resetFixture(repository);
  return outcome;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const selected = CASES.filter((testCase) => {
    if (options.only.length > 0) return options.only.includes(testCase.name);
    return !testCase.real;
  }).filter((testCase) => {
    if (!testCase.real) return true;
    if (!options.consentReal) {
      console.log(`Skipping ${testCase.name}: it issues real provider requests and needs --real.`);
      return false;
    }
    return true;
  });

  if (selected.length === 0) throw new Error("No integration case selected.");
  const executable = await resolveVSCode();
  console.log(`VS Code executable: ${executable}`);
  mkdirSync(options.workRoot, { recursive: true });

  const outcomes: CaseOutcome[] = [];
  for (const testCase of selected) {
    process.stdout.write(`\n=== ${testCase.name} ===\n`);
    const outcome = await runCase(testCase, options, executable);
    outcomes.push(outcome);
    console.log(`${outcome.passed ? "PASS" : "FAIL"} ${outcome.name} (${Math.round(outcome.durationMs / 1000)}s, exit ${outcome.exitCode})`);
    if (!outcome.passed) console.log(`  ${outcome.error ?? "see log"}\n  log: ${outcome.logPath}`);
  }

  writeFileSync(join(options.workRoot, "summary.json"), JSON.stringify(outcomes, null, 2));
  const failed = outcomes.filter((outcome) => !outcome.passed);
  console.log(`\n${outcomes.length - failed.length}/${outcomes.length} integration case(s) passed.`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
