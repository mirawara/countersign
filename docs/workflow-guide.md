# Workflow guide

For the sidebar chat, read the [chat guide](chat-guide.md). This page covers the original workflow started from the Command Palette.

## What this looks like in VS Code

This path does not use the chat. You run a command from the Command Palette, type a task into an input box and confirm the run in a modal dialog. Progress appears in **Output → Countersign**; other commands open the diff, the review and the check output in temporary editor documents.

Every start is a separate workflow. There are no conversations, follow-up messages, attachments or dedicated panel here, and the extension keeps only the most recent result in memory for the current VS Code session. [Codex for IDEs](https://learn.chatgpt.com/docs/codex/ide) and [Claude Code for VS Code](https://code.claude.com/docs/en/vs-code) offer broader conversational interaction; this path exists to run one precise sequence: implementation with Claude, configured checks, review with Codex and at most one correction.

## Requirements

| For | You need |
| --- | --- |
| Everything | VS Code desktop **1.106 or newer** and exactly one trusted project folder. Git is optional, and existing changes do not block a run. |
| Everything | Claude Code CLI and Codex CLI installed, reachable from the extension host and already authenticated. The CLIs must expose the flags the extension requires. The extension never performs a login. |
| Local checks | The executables you configure, for example `node` or `npm`, available on the extension host's `PATH`. |
| Platform | Validated on Linux. macOS has not been verified with the cancellation test. Starting the workflow on Windows is blocked in code. |

Node.js is required to build the extension from source, or if you configure Node as a check.

## Balanced workflow

Every workflow uses Claude for planning and implementation and Codex for review. Both accounts must be signed in. There is no mock execution mode in the extension; automated tests use internal provider fakes.

Countersign uses Caveman at ultra intensity for Claude and Codex prose, under the `countersign.cavemanStyle` setting: the internal provider exchanges are always compressed, while the text you read follows the setting (`auto` by default, which follows the installed skill). Claude CLI turns read its Rules, ultra intensity and Auto-Clarity lines from the selected profile on each request while slash commands remain disabled. Claude SDK turns load the skill natively through an isolated temporary plugin without hooks or MCP servers, reusing the copy while unchanged. Codex CLI reviews keep their isolated configuration and read the same style lines from the installed skill at each request. Updates to these installed instructions apply without rebuilding the extension; a short built-in instruction is used if a skill is unavailable. Paths, code, commands, errors and structured JSON remain exact.

## Installation

With a `.vsix` file: open the Command Palette (`Ctrl+Shift+P`, `Cmd+Shift+P` on macOS), run **Extensions: Install from VSIX...** and select the file. Reload the window if VS Code asks. Look for **Countersign** in the list of installed extensions.

No `.vsix` is published in this repository — see the README for why, and build one with `npm run package`. To try the extension from source, open this folder in VS Code, run `npm ci`, then start the **Run Countersign** launch configuration with `F5`. In the Extension Development Host, open the project folder you want to work on. For build and test commands, see the [README](../README.md#development).

## Set up Claude and Codex

1. Confirm in the integrated terminal that `claude --version` and `codex --version` work. If VS Code started with a different `PATH` than your terminal, set absolute paths in `countersign.claudeExecutable` and `countersign.codexExecutable`.
2. Open **Preferences: Open User Settings (JSON)** and set, for example:

   ```json
   {
     "countersign.localChecks": [
       { "id": "tests", "executable": "node", "args": ["--test"] }
     ]
   }
   ```

   Adapt `localChecks` to your repository's commands. The extension never discovers or starts tests on its own: with an empty list it runs no check at all. Checks take a separate executable and argument array, with no shell. Using user settings avoids creating an untracked `.vscode/settings.json` in the repository under test.
3. Run **Countersign: Verify Claude Settings Isolation**. After your confirmation it runs a controlled test with **two real Claude requests**. A pass applies only to the exact installed Claude CLI version, so repeat it after an upgrade. The verification can consume quota.
   This build requires a new pass even if the CLI version is unchanged. The gate verifies that a probe skill loads in a control turn, then that CLI skills and project hooks are disabled in an isolated turn. Later Caveman skill updates do not require another pass.
4. Run **Start Workflow**. Claude proposes a read-only plan first. The confirmation shows the starting state, permission level, checks and providers. Approve it to begin execution. A real run can consume quota on both accounts.
5. Follow progress in the Output Channel. When it ends, inspect the saved diff, review and check results. In Git folders also compare `git diff` and `git status`. The extension never commits, stages, resets or cleans.

In **Ask before change**, Claude requests approval before edits, commands and network tools; its direct file tools are limited to the workspace, and each configured local check also asks before it runs. An approved Bash command or local check can still affect external files. In **Full access**, Claude can run commands, use the network and change files outside the workspace without further prompts after plan approval. MCP remains disabled. Configured local checks run separately. Codex examines the workflow diff in a read-only sandbox and can read workspace files as context. The diff and report cannot independently audit external files or network actions. No provider API is called directly.

### When a check or the review finds a problem

- A failing local check sets `validation_failed`: the workflow stops and does **not** forward the failure to Claude automatically.
- An eligible Codex finding gets **one** Claude correction pass, after which the checks run again. No second Codex review follows. In that case `completed_clean` means the correction was declared resolved and the checks passed — not that Codex verified the corrected diff.
- A later workflow may start with changes already present. In a clean Git folder, Codex reviews the diff against `HEAD`. In a dirty Git folder, Countersign captures a baseline and reviews only later changes; the original Git entries are listed in the report. In a folder without Git, the review compares files with the baseline captured before planning. Earlier work is excluded from review and correction.
- Snapshot mode skips `node_modules`, `dist`, `build`, `coverage`, `.cache`, `.venv` and `target`. The same generated paths can be included by the Git diff when they are tracked in a clean Git folder, so the review scope depends on the starting state. If a snapshot run finds no reviewable changes, its `no_changes` result names this exclusion and confirms Codex was not called.

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
| `no_changes` | No reviewable changes were detected, so Codex was not called. Snapshot runs name the excluded generated directories in the result message. |
| `validation_failed` | At least one configured check failed. |
| `blocked_provider` / `blocked_auth_or_quota` | Check the CLI, its version, the Claude gate, authentication and account availability. |
| `cancelled` / `timed_out` | The workflow was stopped; check Git state before retrying. |
| `review_failed` / `failed` | See the Output Channel and **Show Diagnostics** for the recorded reason. |

The Output Channel shows states and summaries, not the full prompt, the complete diff or raw check output. Documents opened by the detail commands can contain source code or other sensitive information: close them when you are done. Dirty Git folders and folders without Git use a bounded file snapshot. It excludes `node_modules`, `dist`, `build`, `coverage`, `.cache`, `.venv`, and `target`; edits in those directories are absent from Codex's review and the report, even when other files are reviewed. A clean Git folder instead uses the Git diff, so tracked generated paths can be reviewed there. Snapshot limits are 20,000 files / 64 MiB, changed files over 1 MiB cannot be reviewed, and a single file with more than 2,048 changed-line operations stops the snapshot diff for safety. Clean Git folders use the Git diff, which omits ignored untracked files. `completed_clean` with no checks configured does not prove that a build or a test suite passed.
