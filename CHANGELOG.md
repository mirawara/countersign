# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Mandatory read-only plan approval before every real chat turn and Balanced execution, with post-plan **Ask before change** and **Full access** choices. Ask prompts for edits, commands, network tools and configured local checks; Full access grants broad host access without further prompts.
- Sidebar chat: multiple threads per workspace, search, rename, Markdown export, streaming replies, interactive permission requests and diff artefacts.
- Claude provider through the Claude Agent SDK and Codex provider through `codex app-server`, with model and effort catalogues read from the installed CLI and the active account.
- Isolation gate for chat sessions, bound to the exact installed CLI and SDK versions, with **Countersign: Verify Claude Chat Isolation**.
- Chat modes with a custom instruction and a per-turn timeout, plus the `Balanced` workflow with per-provider model and effort selection.
- One active task per repository, enforced before a turn starts and surfaced in the sidebar.
- Conversation rendering: user messages on the right, agent replies on the left, with headings, lists, quotes, inline code and fenced code blocks built as DOM nodes.
- Brand assets: vector mark for the activity bar, transparent wordmark banners for light and dark themes.
- Public project documents: roadmap, security policy, contribution guide, and an account and redistribution policy for Claude and Codex.

### Changed

- Real chat now makes separate planning and execution requests for each approved message, including questions that do not need file changes. Claude's direct file tools stay inside the repository in Ask mode; approved commands and Codex escalations may reach outside it.
- The mock provider is no longer offered in the sidebar. It remains an internal command used by the packaged integration test, and as a settings-only path for the Command Palette workflow's test cases.
- `Balanced` from the sidebar always runs the real Claude and Codex pair.

### Fixed

- Balanced now shows the actual preflight or provider startup error in the chat instead of a generic start failure.

### Known limitations

- Linux only: macOS is unverified, and Windows execution stays blocked until process-tree cancellation exists there.
- Binary attachments are not supported; persistence across a full VS Code restart is verified at store level only.
- The repository lock coordinates one extension host, so two VS Code windows are not coordinated.
- `Strict` consensus mode, multiple account profiles and automatic account failover are not implemented.
- No prebuilt VSIX is published: a package bundles `@anthropic-ai/claude-agent-sdk`, which is licensed "all rights reserved". Install from source.
