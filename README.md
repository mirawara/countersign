<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="media/countersign-banner-dark.png">
    <img src="media/countersign-banner-light.png" alt="Countersign" width="520">
  </picture>
</p>

<p align="center">
  <em>Two AI agents, one countersigned diff.</em><br>
  A VS Code sidebar chat where Claude writes the code and Codex reviews it — using the CLIs you already installed and signed in to.
</p>

<p align="center">
  <a href="https://github.com/mirawara/countersign/actions/workflows/ci.yml"><img src="https://github.com/mirawara/countersign/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0"></a>
  <img src="https://img.shields.io/badge/VS%20Code-%E2%89%A5%201.106-0078d4.svg" alt="VS Code 1.106 or newer">
  <img src="https://img.shields.io/badge/platform-Linux-informational.svg" alt="Linux">
  <img src="https://img.shields.io/badge/status-early%20preview-orange.svg" alt="Early preview">
  <img src="https://img.shields.io/badge/install-from%20source-lightgrey.svg" alt="Install from source">
</p>

---

Countersign puts a persistent chat in the VS Code sidebar for the **`Balanced` workflow**: Claude implements the change, your configured checks run against the real files, and Codex reviews the diff in a read-only sandbox. A clean Git folder uses the diff against HEAD; a dirty Git folder or a folder without Git uses a file snapshot taken before the task.

It is built around a few deliberate constraints:

- **Your accounts, your login.** The extension launches the `claude` and `codex` CLIs you authenticated yourself. It does not access their login stores for authentication. Workspace files and diffs may contain secret text, so inspect the folder before sending it to a provider. See [Your Claude and Codex accounts](#your-claude-and-codex-accounts).
- **Approve the plan every time.** Real turns show a read-only plan first. After you approve it, **Ask before change** requests permission for edits, commands and network tools; **Full access** runs them without further prompts. An approved command in Ask mode can also affect files outside the repository. Choose the level before sending the task.
- **Verifiable isolation.** Real Claude turns stay blocked until an isolation gate passes for the exact installed CLI and SDK versions.
- **No mock mode in the extension.** Both providers run for a real Balanced workflow. Automated unit tests use provider fakes; live probes are separate, opt-in scripts against temporary folders.

> **Early preview.** This is a personal tool made public, verified on Linux. Several exit criteria are still open — see [Status](#status) and the [roadmap](ROADMAP.md).

## Features

- **Sidebar chat** with multiple threads per workspace, search, rename, Markdown export and a transcript that survives closing the view. Your messages sit on the right, agent replies on the left with headings, lists and syntax-delimited code blocks.
- **Per-task selectors** for Claude model and effort and Codex model and reasoning level, filled from the catalogue the installed CLI exposes for the active account: each model offers exactly the levels its own catalogue lists, with the catalogue's labels, and a level is sent to the provider exactly as it was reported, kept in a **Turn settings** panel that opens over the chat from the bar above the composer, which summarises the chosen models, efforts and permission level.
- **`Balanced` workflow** from the sidebar or the Command Palette: implementation, local checks, structured review of the real diff, and one Claude correction pass with another check run.
- **`Strict` consensus mode**, chosen per task in the sidebar: Claude and Codex must agree on one canonical plan hash, you approve that exact hash, then fresh sessions implement, check, review and approve one snapshot digest. Disagreement, a ceiling, a stall or an unreviewable change ends with a reason instead of a success.
- **Visible accounting**: account label, model actually used, token counts, the provider's own cost estimate and quota status when the provider exposes them, plus `unavailable` when it does not.
- **Local artefacts**: workflow diff, review findings with evidence and raw check output, opened on demand in temporary editor documents.
- **One task per repository**, enforced before a turn starts, so two chats cannot edit the same working tree at once.

## Status

| Area | State |
| --- | --- |
| `Balanced` workflow (implement → check → review → one correction) | Verified live on Linux |
| Sidebar chat, threads, permissions, report and diff | Works; binary attachments missing, full-restart persistence verified at store level only |
| Provider adapters | Balanced uses the Claude CLI for implementation and Codex `exec` for review; SDK and `app-server` remain for capability discovery and permission paths |
| Cross-window task lock | In-memory only: two VS Code windows are not coordinated |
| macOS | Not verified |
| Windows | **Blocked**: process-tree cancellation is not implemented there |
| `Strict` consensus mode | Completed a live `completed_clean` run with the real Claude and Codex CLIs in a temporary one-file repository. Manual packaged UI use and the larger user workspace remain unverified. |
| Account profiles, automatic failover | Not built; see [roadmap](ROADMAP.md) |

## Requirements

- **Linux.** macOS is unverified; Windows execution is blocked.
- **VS Code 1.106** or newer, with the folder opened as a **trusted** workspace.
- Exactly one trusted folder open in the window. Git is optional for the folder under work; Git folders may already contain changes.
- **[Claude Code CLI](https://code.claude.com/docs/en/overview)** and **[Codex CLI](https://learn.chatgpt.com/docs/overview)**, installed and already signed in. Verified against Claude Code 2.1.109 with Agent SDK 0.3.306, and Codex CLI 0.163.0.
- **Node.js 24 LTS and npm** to build from source or produce a VSIX. CI also checks Node.js 22 LTS.

## Install

**From source — the supported path.**

```sh
git clone https://github.com/mirawara/countersign.git
cd countersign
npm ci
npm run compile
npm run package                                  # produces countersign-0.1.0.vsix
code --install-extension countersign-0.1.0.vsix  # then: Developer: Reload Window
```

Or press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

**Why no prebuilt download?** A packaged VSIX bundles `@anthropic-ai/claude-agent-sdk`, whose licence reads "© Anthropic PBC. All rights reserved." Apache-2.0 covers this repository's own code, not a third-party package inside an artefact, so no `.vsix` is published here until Anthropic's terms are confirmed in writing. Building locally keeps that dependency coming to you from npm under Anthropic's own terms. See [docs/third-party-accounts.md](docs/third-party-accounts.md#redistributing-the-package-itself).

## Quick start

1. Open **one trusted project folder** in VS Code — preferably a test folder for your first run. After you approve a real Balanced plan, Claude and Codex both make provider requests, so that first run consumes quota on both accounts; Claude's planning request happens before approval.
2. Run **Countersign: Open Chat** (<kbd>F1</kbd>). The view opens in the Secondary Side Bar on the right.
3. Open **Turn settings** from the bar above the composer, pick a model and effort for **each** provider and choose the **After plan approval** permission level, then start the workflow. Name any files you want the agents to inspect in the task text.
4. Run **Countersign: Verify Claude Settings Isolation** for the installed Claude CLI version. **Ask before change** also needs **Countersign: Verify Claude Chat Isolation** for its SDK path. These checks make real Claude requests and consume quota.
5. Review and approve the plan in chat. With **Ask before change**, approve or deny tool requests as they appear. **Stop** cancels the workflow and its process tree.

For the full walkthrough — account setup, workflow, storage and troubleshooting — read the [chat guide](docs/chat-guide.md).

## The `Balanced` workflow

Open the sidebar, or run **Countersign: Start Workflow** from the Command Palette, then:

1. From the sidebar, Claude proposes a read-only plan. Necessary clarification questions appear in the chat; answer there, then approve the plan in the chat. The Command Palette entry shows the plan in its confirmation dialog.
2. Choose **Ask before change** to review Claude's edits, commands, network tools and each configured local check, or **Full access** to allow those actions, including changes outside the repository, after plan approval. MCP remains disabled. If an agent needs a decision during implementation, review or correction, the workflow pauses for an answer in the chat.
3. A clean Git folder supplies its diff against HEAD. In a dirty Git folder or one without Git, Countersign compares reviewable files with a snapshot taken before planning. Existing Git changes are listed in the report and excluded from Codex's review and Claude's correction. Your configured local checks run against the files.
4. Codex receives Claude's completion summary as context, checks it against the actual diff and workspace files in a read-only sandbox, and returns structured findings with evidence.
5. Findings at or above your threshold get one Claude re-evaluation and correction pass, followed by another check run. There is no second Codex review after the correction.

The sidebar leaves a detailed report in the thread, including the plan, answers, changed files, checks, findings, correction and provider usage. **Show diff** on the report opens the saved patch. Questions can pause between CLI turns; an in-progress tool call cannot be interrupted for a question. If files changed before a question, the workflow checks that their Git snapshot is unchanged before it resumes.

The diff collector refuses excluded paths (common secret names, dependencies, build output), binary new files, more than 40 changed files, new text files over 16 KiB and diffs over 256 KiB. Snapshot diffs also stop if one file requires more than 2,048 inserted or removed line operations to describe. Dirty Git folders and folders without Git retain at most 64 MiB of file contents per scan for patch construction, but the amount read does not stop a task. Files beyond that retention pool are still hashed and compared; a changed file without retained bytes cannot produce a reviewed patch. The 20,000 file count remains; `node_modules`, `dist`, `build`, `coverage`, `.cache`, `.venv`, and `target` are skipped, so changes there are not reviewed or reported. Changed files over 1 MiB cannot be reviewed. Filename exclusions do not prove that no secret is present. Local checks are configured as an executable plus arguments, never inferred from repository scripts; they may change files, and real runs include their reviewable changes. The workflow never resets, stages, commits or cleans anything.

## The `Strict` consensus mode

Pick **Strict** in **Turn settings** before sending a task. `Balanced` stays the default, and the choice belongs to that task: the same conversation can run a Balanced task and then a Strict one, and every message and report keeps its own label.

**Phase A — agreement on a plan.** Claude drafts a structured plan (objective, constraints, acceptance criteria, expected files, risks, checks, open questions) under read-only tools enforced by the CLI, not by prompt text. The plan is serialised canonically — fixed key order, compact JSON, newlines normalised, paths slash-separated, files sorted — and hashed with SHA-256. Claude and Codex each return an explicit `approve`, `reject` or `revise` on that exact hash; prose is never read as agreement, and the hash a model echoes is checked against the one computed locally. Any revision, or any answer you give to a plan question, produces a new hash and voids both approvals.

**The approval gate.** When both providers agree, the plan appears in the chat with its hash and, when the plan says its file list is complete, how many files it expects — information, not a gate. You confirm **Ask before change** or **Full access** here. Nothing is implemented until you approve that hash.

**Phase B — work, review and a second agreement.** A fresh Claude context implements the approved plan, your configured checks run, and a fresh read-only Codex context reviews the snapshot. The snapshot digest covers the reviewable changes in the perimeter, over raw bytes: a whitespace-only edit changes it. Findings come back with file, line and quoted evidence; Claude answers each one as fixed or disputed, with a reason. A review with no findings still needs an explicit approval. Finally Codex approves the digest and Claude approves that same digest against the plan in a context with no write tools. The digest is rebuilt after every provider answer, before and after each check round, between the two approvals and before closing: any reviewable change in the perimeter voids both approvals and restarts the checks and the review.

**What Strict scans.** Unlike Balanced, Strict always walks the filesystem and never asks Git which files exist, so a change under a Git-ignored path such as `internal/` is still reviewed. Every included file is hashed, whatever its size, and files are opened without following symlinks and checked against the identity the scan saw. Each directory is opened the same way and its identity is re-checked after its children are read, so a directory swapped for a link mid-scan aborts the capture instead of pulling outside files in. A symlink is compared by the hash of its target, read without following it. The root itself is opened once and everything bound to it — the scan, every Git command Strict issues, the Claude and Codex processes and the configured checks — runs through that descriptor, so a workspace path replaced between a check and a spawn cannot move them into another tree. Git's own output is used as identity, never as the working directory of the next command, and Strict treats the workspace as a repository only when Git's reported top level is the very directory it pinned. One Git call still runs on the ordinary workspace path, before the task starts: it decides only whether to warn you that the folder has no Git repository root, and it never supplies the status, the HEAD or the working directory of any Strict command. A file above the 1 MiB snapshot limit is still hashed without keeping its bytes: a change in it is always detected, and because it cannot be diffed it blocks a clean completion rather than passing as unchanged. **The size of the workspace is never a reason to refuse a task.** There is no ceiling on how many bytes a Strict scan may read: a 300 MiB folder is hashed in streaming like any other. What is bounded is memory — the scan keeps at most 64 MiB of file contents per pass for building diffs, and a file whose bytes did not fit is still hashed in full. A change in such a file is reported as `content_not_retained`, which is unreviewable and blocks a clean completion; it is kept distinct from `over_file_size_limit`, which is about the file's own size. Nothing here asks you to open a smaller folder or change a setting. Git only supplies the repository identity and the initial HEAD. Dependencies, build output and packaging artefacts are excluded without being read and never enter the digest, so a check writing into `dist/` cannot invalidate its own review. Strict has no protected-path category: files such as `.env`, `.ssh/`, `.aws/`, `.npmrc`, key and credential files are scanned, hashed, reviewed and may be sent to Claude or Codex as workspace context or diff. That is a deliberate decision, and the opposite of `Balanced`, which still refuses those paths: **a secret inside the opened folder is visible to both providers in Strict and appears in the chat report.**

**Ceilings.** Phase A allows 8 provider requests and 20 active minutes; phase B allows 18 requests, 6 review cycles and 90 active minutes; a single request times out after 10 minutes; an invalid structured answer is retried twice; the canonical plan is capped at 64 KiB and a response at 128 KiB. The scan ceilings that can end a task are the file count (20,000) and the diff sizes (256 KiB in total, 16 KiB for a new file); the perimeter's total size is not one of them. There is no per-task ceiling on how many files a Strict task may change: the scan and diff limits above are the only limits on how wide a change can be, and the plan's own file estimate is shown at the approval gate as information. Two consecutive cycles without verifiable progress pause the task. **These numbers are arbitrary placeholders**: the roadmap's measurement phase was skipped by an explicit decision, so none of them comes from measured runs. Every ceiling is frozen once the task starts and shown in the report with whichever one was reached.

**Pause, interruption and restart.** A paused task lives only in the window that owns it: resume or stop it there. Countersign writes a small lifecycle marker in workspace state — task id, window id, mode, timestamp, outcome — and nothing else: no plan, hash, diff, session or permission, so no task can be resumed or repeated from it. On an orderly Reload Window, Countersign cancels the running task and waits for it to finish before VS Code deactivates the extension. An interrupted or finished marker does not block the next task. If a crash leaves an *active* marker from another host, its state cannot be determined safely: inspect the workspace and use **Countersign: Clear Strict interruption marker** after confirming the old task ended. This marker is not a cross-window lock.

`completed_clean` in Strict requires all of: both providers agreeing on one plan hash, your approval, the configured checks passing on the last snapshot, no open blocking finding, explicit Codex and Claude approvals of the same final digest, a stable baseline and workspace, and no excluded or unreviewable change. Anything else is a named failure with a next action. If nothing changed, the result is `no_changes` and the report says no final review happened.

## Model and effort menus

**CLI accounts.** Turn settings has a separate account selector for Claude and Codex. The default uses each CLI's current login. **Add** can import an existing profile directory or create a new one; **Sign in** opens the official CLI login in a terminal for that directory. After **Refresh**, every registered profile is checked for an email and the picker shows it beside that choice when supplied by the CLI. The collapsed settings bar shows the selected emails. The same card shows provider-reported plan usage windows when available, with the time checked; these percentages are snapshots, not a guarantee that the next turn will be accepted. Claude's structured usage read is experimental and may return no data. The provider owns its credentials. Countersign stores only a label and path for each profile, refreshes the selected account's model catalogue, and fixes both profile choices for the task. There is no automatic account switch after a quota stop. See [Claude and Codex accounts](docs/third-party-accounts.md) for setup and storage details.

The menus come from the catalogue the installed CLI exposes for the signed-in account: `supportedModels()` for Claude, `model/list` for Codex. Countersign keeps no list of its own. Each model offers exactly the levels its catalogue reports, labelled as the catalogue labels them, and whatever you pick is sent to the provider unchanged — a level this build has never heard of works the day the provider ships it.

A stored choice is reconciled, not enforced: when a model or a level is no longer offered, the sidebar keeps showing the saved value and warns that a turn started now will use the CLI default for it. The saved preference is not erased by a catalogue refresh or a window reload. The Output Channel also records the fallback.

Those menus still come from a provider version this project has verified: Countersign checks the exact CLI and SDK versions before a real turn. Reading the catalogue dynamically means new entries from a **verified** version appear without a code change; it is not a promise that an unverified version will work.

## Safety model

| Guard | What it means |
| --- | --- |
| Isolation gate | Real Claude turns are blocked until a reproducible probe shows which setting sources the CLI reads and where session state is written, for the exact installed versions. The record lives in `~/.countersign/claude-gate.json` with owner-only permissions and lapses when a version changes. |
| Explicit permissions | Every Balanced workflow requires plan approval before execution. Ask before change prompts for edits, commands and network tools; Claude's direct file tools are limited to the workspace. An approved command or Codex escalation can still affect external files. Full access gives the agent broad access without further prompts. The saved workspace diff does not audit external files or network actions. Codex stays read-only when reviewing a Balanced diff. |
| Workspace trust | Real turns require a trusted workspace, one folder and a verified platform. |
| No login credential handling by Countersign | The extension does not access provider login stores or use API keys for authentication, and runs no telemetry. Strict scans all included workspace files, including credential-named files, and may send their contents to Claude or Codex as context or diff. **Full access gives the provider's tools access to the host**, including files and environment variables that may contain credentials; Countersign cannot audit their use outside the workspace. |
| Bounded output | The Output Channel carries task IDs, states and bounded summaries — never prompts, diffs, finding evidence or raw check output. The detailed report stays in workspace chat history; full diffs, review details and check output open on demand and may contain sensitive repository data. |
| Cancellation | **Stop** and **Cancel Workflow** escalate from SIGTERM to SIGKILL across the process group after a grace period, in both modes. |
| Strict provider sessions | Every Strict turn is a new native context — no session id, no resume id, session persistence off — and Codex reviews in a sandbox the CLI enforces. If the installed versions cannot prove a fresh context or a read-only sandbox, Strict refuses to start instead of trusting a prompt instruction. |

Found a security problem? See [SECURITY.md](SECURITY.md).

## Your Claude and Codex accounts

Countersign drives CLIs you installed and signed in to. It has no login of its own and cannot create one for you. Turns consume your own subscription limits or API credits; the US dollar figures shown in chat are the CLI's own estimates at API list prices, not a charge on a subscription seat. When a limit is reached, the turn stops and explains — there is no account rotation and no automatic failover.

**If you plan to fork or redistribute this, read [docs/third-party-accounts.md](docs/third-party-accounts.md) first.** Countersign has no in-product login, but the rules for distributing its Claude SDK integration and provider-reported quota display are not settled by the personal-use review. Anthropic's published guidance restricts third-party products that offer claude.ai login or usage limits; OpenAI has separate paths for in-product ChatGPT sign-in.

Countersign is an independent project, not affiliated with or endorsed by Anthropic or OpenAI.

## Configuration

Settings live under `countersign.*`. The ones you are most likely to touch:

| Setting | Default | Purpose |
| --- | --- | --- |
| `claudeExecutable` / `codexExecutable` | `claude` / `codex` | Paths to the CLIs. |
| `executionPermission` | `askBeforeChange` | Default for Command Palette workflows; the sidebar selector overrides it per turn. `fullAccess` grants commands, network and external file access after plan approval. |
| `claudeAllowedTools` | `Read, Glob, Grep, Edit, Write` | Legacy bounded tool list; the two execution permission modes use their own tool policy. |
| `localChecks` | `[]` | Checks as `{ id, executable, args }`. Never inferred from `package.json`. |
| `findingThreshold` | `High` | Minimum severity that triggers a correction pass. |
| `taskTimeoutMinutes`, `providerTimeoutMinutes`, `checkTimeoutMinutes` | `30`, `15`, `5` | Guard rails for the extension's loop. |

Countersign does not set a per-request USD budget for Claude in either workflow, chat, or their verification gates. Account usage and provider limits are handled by Claude; the extension still reports usage estimates when the CLI supplies them.

Mock providers are internal test fixtures and cannot be selected in the extension.

## Documentation

- [Chat guide](docs/chat-guide.md) — sidebar, selectors, accounts, storage, troubleshooting
- [Workflow guide](docs/workflow-guide.md) — the Command Palette workflow end to end
- [Verification results](docs/verification.md) — probes, versions and limits behind every capability claim
- [Claude and Codex accounts](docs/third-party-accounts.md) — what the extension does with your accounts, and the redistribution question
- [Roadmap](ROADMAP.md) — CLI, macOS and Windows support, `Strict` mode, what is not planned
- [Changelog](CHANGELOG.md)

## Development

```sh
npm ci
npm run compile      # tsc
npm run lint         # eslint
npm test             # vitest + test typecheck, no provider requests
```

Unit tests use mocked provider runners and temporary Git repositories. The webview script is exercised through a DOM double, so the chat rendering is covered without a browser.

Integration cases drive the real VS Code commands in an extension host, with the input box and confirmation modal answered by the harness. The fixture templates are checked into `tests/integration/fixtures/`; the runner copies each one into the work directory and creates a temporary Git repository with a baseline commit. No provider request is sent by the default suite. On a machine with a display, run:

```sh
npm run test:integration -- --work=/tmp/countersign-integration
```

On a headless Linux machine, use Xvfb:

```sh
xvfb-run -a npm run test:integration -- --work=/tmp/countersign-integration
```

CI runs the default mock-only suite under Xvfb, including the process-tree cancellation case. `--real` adds the live Claude and Codex workflow case, which edits the temporary repository and consumes account quota. `--packaged=<extensions-dir>` runs the cases against the files of an installed VSIX instead of the sources.

Live probe scripts under `scripts/` (`--live`) talk to the real CLIs on temporary repositories and consume quota. They are run by hand, never from CI.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[Apache-2.0](LICENSE) © 2026 Lorenzo Mirabella.
