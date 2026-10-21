# Workflow guide

For the sidebar chat, read the [chat guide](chat-guide.md). This page covers the original workflow started from the Command Palette.

## What this looks like in VS Code

This path does not use the chat. You run a command from the Command Palette, type a task into an input box and confirm the run in a modal dialog. Progress appears in **Output → Countersign**; other commands open the diff, the review and the check output in temporary editor documents.

Every start is a separate workflow. There are no conversations, follow-up messages, attachments or dedicated panel here, and the extension keeps only the most recent result in memory for the current VS Code session. [Codex for IDEs](https://learn.chatgpt.com/docs/codex/ide) and [Claude Code for VS Code](https://code.claude.com/docs/en/vs-code) offer broader conversational interaction; this path exists to run one precise sequence: implementation with Claude, configured checks, review with Codex and at most one correction.

## Requirements

| For | You need |
| --- | --- |
| Everything | VS Code desktop **1.106 or newer** and exactly one trusted project folder. Git is optional, and existing changes do not block a run. |
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
| `claude` | `real` | Claude edits the workspace, the configured checks run, and Codex reviews the real Git or file snapshot diff. |

The combination `claude` + `mock` is not allowed. The modes are set with `countersign.provider` and `countersign.codexProvider`.

## Installation

With a `.vsix` file: open the Command Palette (`Ctrl+Shift+P`, `Cmd+Shift+P` on macOS), run **Extensions: Install from VSIX...** and select the file. Reload the window if VS Code asks. Look for **Countersign** in the list of installed extensions.

No `.vsix` is published in this repository — see the README for why, and build one with `npm run package`. To try the extension from source, open this folder in VS Code, run `npm ci`, then start the **Run Countersign** launch configuration with `F5`. In the Extension Development Host, open the project folder you want to work on. For build and test commands, see the [README](../README.md#development).

## A first run with no AI request

1. Open a small test folder in VS Code — not the extension's own repository — and grant Workspace Trust. It may be a Git repository or an ordinary folder.
2. Check the folder contents. Existing files are preserved; Countersign never cleans them.
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
4. Run **Start Workflow**. Claude proposes a read-only plan first. The confirmation shows the starting state, permission level, checks and providers. Approve it to begin execution. A real run can consume quota on both accounts.
5. Follow progress in the Output Channel. When it ends, inspect the saved diff, review and check results. In Git folders also compare `git diff` and `git status`. The extension never commits, stages, resets or cleans.

In **Ask before change**, Claude requests approval before edits, commands and network tools; its direct file tools are limited to the repository, and each configured local check also asks before it runs. An approved Bash command or local check can still affect external files. In **Full access**, Claude can run commands, use the network and change files outside the repository without further prompts after plan approval. MCP remains disabled. Configured local checks run separately. Codex examines the repository diff in a read-only sandbox and can read repository files as context. The diff and report cannot independently audit external files or network actions. No provider API is called directly.

### When a check or the review finds a problem

- A failing local check sets `validation_failed`: the workflow stops and does **not** forward the failure to Claude automatically.
- An eligible Codex finding gets **one** Claude correction pass, after which the checks run again. No second Codex review follows. In that case `completed_clean` means the correction was declared resolved and the checks passed — not that Codex verified the corrected diff.
- A later workflow may start with changes already present. Its report lists the initial Git entries separately; the review still sees the full diff against HEAD. In an ordinary folder, the review sees changes since that workflow's file snapshot. There is no follow-up conversation about the previous run.

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
| `blocked_dirty_repository` | Legacy state; existing changes no longer block startup. |
| `blocked_provider` / `blocked_auth_or_quota` | Check the CLI, its version, the Claude gate, authentication and account availability. |
| `cancelled` / `timed_out` | The workflow was stopped; check Git state before retrying. |
| `review_failed` / `failed` | See the Output Channel and **Show Diagnostics** for the recorded reason. |

The Output Channel shows states and summaries, not the full prompt, the complete diff or raw check output. Documents opened by the detail commands can contain source code or other sensitive information: close them when you are done. Git-ignored files do not enter the Git diff; an ordinary folder excludes generated directories and limits snapshots to 20,000 files / 64 MiB. `completed_clean` with no checks configured does not prove that a build or a test suite passed.
