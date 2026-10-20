# AI Dev Orchestrator

A local VS Code extension for one bounded development workflow. The default is a mock run with no AI request. Real implementation uses Claude CLI; real review uses Codex CLI in its read-only sandbox. No direct provider API is used.

## Modes

- `provider: mock`, `codexProvider: mock`: simulate implementation, review, and one correction in memory. No repository code is edited by the providers.
- `provider: mock`, `codexProvider: real`: send the synthetic in-memory diff to Codex after confirmation. This is useful only for exercising the adapter and can consume quota; it does not review a real implementation.
- `provider: claude`, `codexProvider: real`: Claude edits the repository with the confirmed built-in tool allowlist. Git collects the actual diff, configured local checks run, and Codex reviews that diff. Eligible findings can receive one Claude re-evaluation and correction pass, followed by another check run. There is no second Codex review after correction.

The real Claude mode stays blocked until **AI Dev Orchestrator: Verify Claude Settings Isolation** passes for the exact installed CLI version. That command asks for separate confirmation because it starts two live Claude requests. It creates a temporary project hook, verifies that the control run triggers it, then checks that `--setting-sources ""` suppresses it. An inconclusive result leaves the gate closed. The gate record is stored in `~/.ai-dev-orchestrator/claude-gate.json` with owner-only permissions and becomes inapplicable when the CLI version changes. The test does not edit or copy existing settings or credentials. Existing user hooks can run during the control request.

The current local Claude and Codex CLI help declare the required flags. The Claude gate passed on 19 October 2026 for Claude Code 2.1.109. A live Codex review also passed on Codex CLI 0.163.0 against a deliberately broken function in a temporary Git repository; it returned a structured finding for the regression. On 20 October 2026 the full workflow ran live on Linux with those same CLI versions: Claude edited a temporary repository, the configured check passed, and Codex returned a clean structured review. These smoke tests do not establish future account quota, billing, or every sandbox behavior.

## Use

1. Open exactly one trusted, clean Git repository root in VS Code. Use a repository other than this one for a trial run, so a failed task cannot disturb the extension sources.
2. Set `aiDevOrchestrator.provider` and `aiDevOrchestrator.codexProvider`. Real Claude requires real Codex. Optionally set executable paths, allowed Claude tools, local checks, timeouts, and the estimated budget guard.
3. For real Claude, run **Verify Claude Settings Isolation** and confirm its two requests. Repeat after a CLI version change.
4. Run **Start Workflow**, enter the task, review the repository, task, tools, checks and provider disclosure, then confirm.
5. Use **Show Workflow Status**, **Show Workflow Diff**, **Show Review Details**, **Show Check Results** and **Show Diagnostics** to inspect the outcome. **Cancel Workflow** sends termination to the active process group.

The Output Channel contains task IDs, states and bounded summaries, but not the task prompt, diff, finding evidence or raw check output. The detail commands open local temporary editor documents on demand. These documents may contain sensitive repository data; close them when finished. Git-ignored files are outside normal status and diff collection.

Local checks are configured as an executable and argument array, never inferred from repository scripts. They can change repository files. Real runs include those tracked or untracked changes in the review diff. In mock runs, such changes cause validation failure so a synthetic review cannot be reported as clean. The workflow never resets, stages, commits, or cleans files.

The real diff collector blocks excluded paths (including common secret names, dependencies and build output), binary new files, more than 40 changed files, new text files over 16 KiB, and diffs over 256 KiB. Filename exclusions do not prove that every secret is absent. The reviewer can still read repository files as context under its sandbox. A failed or cancelled real run can leave partial edits; inspect Git status before restarting.

Windows workflow execution is blocked until process-tree cancellation is implemented there. On POSIX, cancellation and output-limit handling escalate from SIGTERM to SIGKILL after the configured grace period.

## Development

Run `npm install`, `npm run compile`, `npm run lint`, and `npm test`. The tests use mocked provider runners and temporary Git repositories; they do not send AI requests. Open the folder in VS Code and use the Run and Debug launch configuration to start an Extension Development Host.

`npm run test:integration` drives the real VS Code commands in an extension host, with the input box and confirmation modal answered by the test harness. It needs a display and a temporary fixture repository, and takes the fixture and working directories as arguments:

```sh
npm run test:integration -- --fixtures=<dir> --work=<dir>
```

By default it runs only mock cases and sends no AI request. `--packaged=<extensions-dir>` runs the same cases against an installed VSIX instead of the sources. `--real` adds the live Claude and Codex case, which edits the fixture repository and consumes account quota, so it stays opt-in.

The [validation plan](ACTION_PLAN.md) records how the MVP was validated and what remains open.
