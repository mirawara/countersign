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

Countersign puts a persistent chat in the VS Code sidebar and lets you hand a workspace task to Claude or Codex. Its point is the **`Balanced` workflow**: Claude implements the change, your configured checks run against the real files, and Codex reviews the diff in a read-only sandbox. Git folders use the diff against HEAD; other folders use a file snapshot taken before the task.

It is built around a few deliberate constraints:

- **Your accounts, your login.** The extension launches the `claude` and `codex` CLIs you authenticated yourself. It does not access their login stores for authentication. Workspace files and diffs may contain secret text, so inspect the folder before sending it to a provider. See [Your Claude and Codex accounts](#your-claude-and-codex-accounts).
- **Approve the plan every time.** Real turns show a read-only plan first. After you approve it, **Ask before change** requests permission for edits, commands and network tools; **Full access** runs them without further prompts. An approved command in Ask mode can also affect files outside the repository. Choose the level before sending the task.
- **Verifiable isolation.** Real Claude turns stay blocked until an isolation gate passes for the exact installed CLI and SDK versions.
- **Mock-only CI.** The automated suite never sends a provider request. Live probes are separate, opt-in scripts against temporary repositories.

> **Early preview.** This is a personal tool made public, verified on Linux. Several exit criteria are still open — see [Status](#status) and the [roadmap](ROADMAP.md).

## Features

- **Sidebar chat** with multiple threads per workspace, search, rename, Markdown export and a transcript that survives closing the view. Your messages sit on the right, agent replies on the left with headings, lists and syntax-delimited code blocks.
- **Per-turn selectors** for provider, model and effort/reasoning level, filled from what the installed CLI and your account actually offer — not a hard-coded list. Claude effort and Codex reasoning effort stay separate parameters.
- **`Balanced` workflow** from the sidebar or the Command Palette: implementation, local checks, structured review of the real diff, and one Claude correction pass with another check run.
- **Chat modes** you define yourself, each with its own instruction and per-turn timeout.
- **Visible accounting**: account label, model actually used, token counts, the provider's own cost estimate and quota status when the provider exposes them, plus `unavailable` when it does not.
- **Local artefacts**: workflow diff, review findings with evidence and raw check output, opened on demand in temporary editor documents.
- **One task per repository**, enforced before a turn starts, so two chats cannot edit the same working tree at once.

## Status

| Area | State |
| --- | --- |
| `Balanced` workflow (implement → check → review → one correction) | Verified live on Linux |
| Sidebar chat, threads, streaming, permissions, diff | Works; binary attachments missing, full-restart persistence verified at store level only |
| Claude via Agent SDK, Codex via app-server | Works; Codex `app-server` is marked experimental upstream, with the `exec` path kept as fallback |
| Cross-window task lock | In-memory only: two VS Code windows are not coordinated |
| macOS | Not verified |
| Windows | **Blocked**: process-tree cancellation is not implemented there |
| `Strict` consensus mode, account profiles, automatic failover | Not built; see [roadmap](ROADMAP.md) |

## Requirements

- **Linux.** macOS is unverified; Windows execution is blocked.
- **VS Code 1.106** or newer, with the folder opened as a **trusted** workspace.
- Exactly one trusted folder open in the window. Git is optional for the folder under work; Git folders may already contain changes.
- **[Claude Code CLI](https://code.claude.com/docs/en/overview)** and/or **[Codex CLI](https://learn.chatgpt.com/docs/overview)**, installed and already signed in. Verified against Claude Code 2.1.109 with Agent SDK 0.3.306, and Codex CLI 0.163.0.
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

1. Open **one trusted project folder** in VS Code — preferably a test folder for your first run.
2. Run **Countersign: Open Chat** (<kbd>F1</kbd>). The view opens in the Secondary Side Bar on the right.
3. Pick a **provider**, **model**, **effort** and **After plan approval** permission level, then send a message. **Add file** attaches the active file or your current selection as a reference.
4. For real Claude turns, run **Countersign: Verify Claude Chat Isolation** once per CLI/SDK version and confirm its two live requests. Until it passes, real Claude chat stays closed.
5. Review and approve the plan in chat. With **Ask before change**, approve or deny tool requests as they appear. **Stop** cancels the turn and its process tree.

For the full walkthrough — account setup, modes, storage, troubleshooting — read the [chat guide](docs/chat-guide.md).

## The `Balanced` workflow

Select **Claude + Codex (Balanced)** as the mode, or run **Countersign: Start Workflow** from the Command Palette, then:

1. From the sidebar, Claude proposes a read-only plan. Necessary clarification questions appear in the chat; answer there, then approve the plan in the chat. The Command Palette entry shows the plan in its confirmation dialog.
2. Choose **Ask before change** to review Claude's edits, commands, network tools and each configured local check, or **Full access** to allow those actions, including changes outside the repository, after plan approval. MCP remains disabled. If an agent needs a decision during implementation, review or correction, the workflow pauses for an answer in the chat.
3. Git collects the real diff in a repository; in a folder without Git, Countersign compares reviewable files with a snapshot taken before planning. Your configured local checks run against the files.
4. Codex receives Claude's completion summary as context, checks it against the actual diff and workspace files in a read-only sandbox, and returns structured findings with evidence.
5. Findings at or above your threshold get one Claude re-evaluation and correction pass, followed by another check run. There is no second Codex review after the correction.

The sidebar leaves a detailed report in the thread, including the plan, answers, changed files, checks, findings, correction and provider usage. **Show diff** on the report opens the saved patch. Questions can pause between CLI turns; an in-progress tool call cannot be interrupted for a question. If files changed before a question, the workflow checks that their Git snapshot is unchanged before it resumes.

The diff collector refuses excluded paths (common secret names, dependencies, build output), binary new files, more than 40 changed files, new text files over 16 KiB and diffs over 256 KiB. A folder without Git also has a 20,000 file / 64 MiB snapshot limit; generated directories are skipped, and changed files over 1 MiB cannot be reviewed. Filename exclusions do not prove that no secret is present. Local checks are configured as an executable plus arguments, never inferred from repository scripts; they may change files, and real runs include those changes in the reviewed diff. The workflow never resets, stages, commits or cleans anything.

## Safety model

| Guard | What it means |
| --- | --- |
| Isolation gate | Real Claude turns are blocked until a reproducible probe shows which setting sources the CLI reads and where session state is written, for the exact installed versions. The record lives in `~/.countersign/claude-gate.json` with owner-only permissions and lapses when a version changes. |
| Explicit permissions | Every real chat turn and Balanced workflow requires plan approval before execution. Ask before change prompts for edits, commands and network tools; Claude's direct file tools are limited to the workspace. An approved command or Codex escalation can still affect external files. Full access gives the agent broad access without further prompts. The saved workspace diff does not audit external files or network actions. Codex stays read-only when reviewing a Balanced diff. |
| Workspace trust | Real turns require a trusted workspace, one folder and a verified platform. |
| No login credential handling by Countersign | The extension does not access provider login stores or use API keys for authentication, and runs no telemetry. File snapshots and diffs can contain secrets embedded in workspace text files; filename exclusions cannot prevent every case. **Full access gives the provider's tools access to the host**, including files and environment variables that may contain credentials; Countersign cannot audit their use outside the workspace. |
| Bounded output | The Output Channel carries task IDs, states and bounded summaries — never prompts, diffs, finding evidence or raw check output. The detailed report stays in workspace chat history; full diffs, review details and check output open on demand and may contain sensitive repository data. |
| Cancellation | **Stop** and **Cancel Workflow** escalate from SIGTERM to SIGKILL across the process group after a grace period. |

Found a security problem? See [SECURITY.md](SECURITY.md).

## Your Claude and Codex accounts

Countersign drives CLIs you installed and signed in to. It has no login of its own and cannot create one for you. Turns consume your own subscription limits or API credits; the US dollar figures shown in chat are the CLI's own estimates at API list prices, not a charge on a subscription seat. When a limit is reached, the turn stops and explains — there is no account rotation and no automatic failover.

**If you plan to fork or redistribute this, read [docs/third-party-accounts.md](docs/third-party-accounts.md) first.** Countersign has no in-product login, but the rules for distributing its Claude SDK integration and provider-reported quota display are not settled by the personal-use review. Anthropic's published guidance restricts third-party products that offer claude.ai login or usage limits; OpenAI has separate paths for in-product ChatGPT sign-in.

Countersign is an independent project, not affiliated with or endorsed by Anthropic or OpenAI.

## Configuration

Settings live under `countersign.*`. The ones you are most likely to touch:

| Setting | Default | Purpose |
| --- | --- | --- |
| `provider` | `mock` | Implementation provider for the Command Palette workflow (`mock` or `claude`). The sidebar always uses real agents. |
| `codexProvider` | `mock` | Review provider for the Command Palette workflow (`mock` or `real`). |
| `claudeExecutable` / `codexExecutable` | `claude` / `codex` | Paths to the CLIs. |
| `executionPermission` | `askBeforeChange` | Default for Command Palette workflows; the sidebar selector overrides it per turn. `fullAccess` grants commands, network and external file access after plan approval. |
| `claudeAllowedTools` | `Read, Glob, Grep, Edit, Write` | Legacy bounded tool list; the two execution permission modes use their own tool policy. |
| `localChecks` | `[]` | Checks as `{ id, executable, args }`. Never inferred from `package.json`. |
| `findingThreshold` | `High` | Minimum severity that triggers a correction pass. |
| `taskTimeoutMinutes`, `providerTimeoutMinutes`, `checkTimeoutMinutes` | `30`, `15`, `5` | Guard rails for the extension's loop. |
| `budgetGuardUsd` | `1` | Stops a run past an estimated spend. An estimate, not a billing cap. |

`mock` settings exist for the test suite; the sidebar does not offer a mock provider.

## Documentation

- [Chat guide](docs/chat-guide.md) — sidebar, selectors, accounts, modes, storage, troubleshooting
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

Integration cases drive the real VS Code commands in an extension host, with the input box and confirmation modal answered by the harness. They need a display and a fixture repository:

```sh
npm run test:integration -- --fixtures=<dir> --work=<dir>
```

By default only mock cases run and no provider request is sent. `--real` adds the live Claude and Codex workflow case, which edits the fixture repository and consumes account quota. `--packaged=<extensions-dir>` runs the cases against the files of an installed VSIX instead of the sources.

Live probe scripts under `scripts/` (`--live`) talk to the real CLIs on temporary repositories and consume quota. They are run by hand, never from CI.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[Apache-2.0](LICENSE) © 2026 Lorenzo Mirabella.
