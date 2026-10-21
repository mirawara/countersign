# Workflow guide

For the sidebar chat, read the [chat guide](chat-guide.md). This page covers the original workflow started from the Command Palette.

## What this looks like in VS Code

This path does not use the chat. You run a command from the Command Palette, type a task into an input box and confirm the run in a modal dialog. Progress appears in **Output → Countersign**; other commands open the diff, the review and the check output in temporary editor documents.

Every start is a separate workflow. There are no conversations, follow-up messages, attachments or dedicated panel here, and the extension keeps only the most recent result in memory for the current VS Code session. [Codex for IDEs](https://learn.chatgpt.com/docs/codex/ide) and [Claude Code for VS Code](https://code.claude.com/docs/en/vs-code) offer broader conversational interaction; this path exists to run one precise sequence: implementation with Claude, configured checks, review with Codex and at most one correction.

## Requirements

| For | You need |
| --- | --- |
| Everything | VS Code desktop **1.106 or newer**, Git on `PATH`, and exactly one open folder that is the root of a Git repository VS Code trusts. The repository must be clean, untracked files included. |
| A first mock run | No AI CLI and no AI account. Both provider settings default to `mock`, and local checks are empty by default. |
| A real workflow | Claude Code CLI and Codex CLI installed, reachable from the extension host and already authenticated. The CLIs must expose the flags the extension requires. The extension never performs a login. |
| Local checks | The executables you configure, for example `node` or `npm`, available on the extension host's `PATH`. |
| Platform | Validated on Linux. macOS has not been verified with the cancellation test. Starting the workflow on Windows is blocked in code. |

Node.js is not required to run an installed build in mock mode without local checks. It is required to build the extension from source, or if you configure Node as a check.

## Available modes

| Implementation | Review | Effect |
| --- | --- | --- |
| `mock` | `mock` | Default trial with no AI request; changes are simulated in memory. |
| `mock` | `real` | Codex reviews a synthetic diff. It consumes quota without reviewing a real change. |
| `claude` | `real` | Claude edits the repository, the configured checks run, and Codex reviews the real Git diff. |

The combination `claude` + `mock` is not allowed. The modes are set with `countersign.provider` and `countersign.codexProvider`.

## Installation

With a `.vsix` file: open the Command Palette (`Ctrl+Shift+P`, `Cmd+Shift+P` on macOS), run **Extensions: Install from VSIX...** and select the file. Reload the window if VS Code asks. Look for **Countersign** in the list of installed extensions.

No `.vsix` is published in this repository — see the README for why, and build one with `npm run package`. To try the extension from source, open this folder in VS Code, run `npm ci`, then start the **Run Countersign** launch configuration with `F5`. In the Extension Development Host, open the Git repository you want to work on. For build and test commands, see the [README](../README.md#development).

## A first run with no AI request

1. Open the root of a small test repository in VS Code — not the extension's own repository — and grant Workspace Trust.
2. Check with `git status --short` that there are no changes. If you have work to keep, deal with it first: the extension never cleans your tree.
3. Keep the defaults: `countersign.provider = mock` and `countersign.codexProvider = mock`.
4. Open the Command Palette, run **Countersign: Start Workflow**, enter a task, and confirm after reading the repository, task and checks shown in the dialog.
5. Open **Output → Countersign**, then use **Show Workflow Status**, **Show Workflow Diff**, **Show Review Details** and **Show Check Results** for the detail.

With the defaults the diff is simulated in memory: Claude and Codex are not called, and the mock providers change no files. Local checks, if you configure them, are real processes that can change the repository even during a mock run; the workflow then reports `validation_failed`.

## Switching to real Claude and Codex

1. Confirm in the integrated terminal that `claude --version` and `codex --version` work. If VS Code started with a different `PATH` than your terminal, set absolute paths in `countersign.claudeExecutable` and `countersign.codexExecutable`.
2. Open **Preferences: Open User Settings (JSON)** and set, for example:

   ```json
   {
     "countersign.provider": "claude",
     "countersign.codexProvider": "real",
     "countersign.localChecks": [
       { "id": "tests", "executable": "node", "args": ["--test"] }
     ]
   }
   ```

   Adapt `localChecks` to your repository's commands. The extension never discovers or starts tests on its own: with an empty list it runs no check at all. Checks take a separate executable and argument array, with no shell. Using user settings avoids creating an untracked `.vscode/settings.json` in the repository under test.
3. Run **Countersign: Verify Claude Settings Isolation**. After your confirmation it runs a controlled test with **two real Claude requests**. A pass applies only to the exact installed Claude CLI version, so repeat it after an upgrade. The verification can consume quota.
4. Make sure the repository is clean and run **Start Workflow**. The confirmation shows the repository, the task, the tools granted to Claude, the checks and the providers. Accept only after checking those. A real run can consume quota on both accounts.
5. Follow progress in the Output Channel. When it ends, open the diff, the review and the check results, and compare `git diff` and `git status` before keeping anything. The extension never commits, stages, resets or cleans.

In real mode Claude may use only `Read`, `Glob`, `Grep`, `Edit` and `Write`, per the confirmed allowlist. It does not use Bash: local checks are started separately by the extension. Codex examines the diff in a read-only sandbox and can read repository files as context. No provider API is called directly.

### When a check or the review finds a problem

- A failing local check sets `validation_failed`: the workflow stops and does **not** forward the failure to Claude automatically.
- An eligible Codex finding gets **one** Claude correction pass, after which the checks run again. No second Codex review follows. In that case `completed_clean` means the correction was declared resolved and the checks passed — not that Codex verified the corrected diff.
- After a real run the repository normally contains changes. To start another workflow you must deliberately return it to a clean Git state, for example by committing. There is no follow-up conversation about the previous run.

## Commands

Open them from the Command Palette by searching for **Countersign**.

| Command | Use |
| --- | --- |
| **Start Workflow** | Takes the task, asks for confirmation and starts the workflow. |
| **Cancel Workflow** | Requests that the active workflow stop; a real run can leave partial changes to inspect with Git. |
| **Show Workflow Status** | Shows the current state and the last result. |
| **Show Workflow Diff** | Opens the real or simulated diff of the last result. |
| **Show Review Details** | Opens the summary and findings of the last review. |
| **Show Check Results** | Opens the outcomes and output of the configured checks. |
| **Show Diagnostics** | Writes versions and diagnostic state to the Output Channel, without reading credentials. |
| **Verify Claude Settings Isolation** | Runs the gate required for real Claude. |

## Reading the outcomes

| State | What it means in practice |
| --- | --- |
| `completed_clean` | The sequence finished with no reported findings left. Check whether any test was configured, and whether a correction happened that Codex never reviewed. |
| `completed_with_findings` | Findings remain; read them in **Show Review Details**. |
| `validation_failed` | At least one check failed, or a check changed the repository during a mock run. |
| `blocked_dirty_repository` | Git saw changes or untracked files before the start. |
| `blocked_provider` / `blocked_auth_or_quota` | Check the CLI, its version, the Claude gate, authentication and account availability. |
| `cancelled` / `timed_out` | The workflow was stopped; check Git state before retrying. |
| `review_failed` / `failed` | See the Output Channel and **Show Diagnostics** for the recorded reason. |

The Output Channel shows states and summaries, not the full prompt, the complete diff or raw check output. Documents opened by the detail commands can contain source code or other sensitive information: close them when you are done. Git-ignored files do not enter the normal diff and review. `completed_clean` with no checks configured does not prove that a build or a test suite passed.
