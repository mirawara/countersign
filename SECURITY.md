# Security policy

## Reporting a vulnerability

Report privately through GitHub's [security advisory form](https://github.com/mirawara/countersign/security/advisories/new). Please do not open a public issue for a vulnerability.

Include the extension version, your OS, your VS Code version, the Claude Code and Codex CLI versions, and the steps to reproduce. Expect a first response within a week; this is a small project maintained in spare time, and that is the honest expectation rather than a service level.

## Scope

In scope: anything that makes the extension read, store or leak credentials; execute before plan approval; execute an Ask before change action without its required permission request; enable Full access without the user's explicit selection and plan approval; escape the isolation gate or the workspace-trust requirement; leak repository contents into logs; or let a provider's output influence the extension as if it were code (for example HTML injected into the webview).

Out of scope: vulnerabilities in the Claude Code CLI, the Codex CLI, the Claude Agent SDK, VS Code itself or any other dependency — report those to their maintainers. Also out of scope: the models' own behaviour, including a model proposing a bad change, and account quota or billing questions.

## What the extension does with your data

- **Credentials: never touched.** It does not read, copy, store, display or transmit tokens, cookies, session files or API keys. Authentication happens inside the provider CLIs, with their own login flows.
- **Provider tool access depends on the selected level.** Every real turn needs a read-only plan approved first. Ask before change requests permission for edits, commands and network tools; Claude's direct file tools are limited to the repository. An approved command, Codex escalation or local check can still affect external files. Full access gives the provider's tools access to the host, including credential files and environment variables, without further prompts. Countersign cannot independently audit actions outside the repository.
- **Repository contents** are sent to the provider you selected, as the prompt, file references and diffs that the turn requires. That is the entire point of the tool, and it is the user's decision per turn.
- **Transcripts and artefacts** are stored locally in the extension's workspace storage. They can contain source code and other sensitive repository data. **Countersign: Clear Chat History** deletes them.
- **The Output Channel** carries task IDs, states and bounded summaries only — never prompts, diffs, finding evidence or raw check output.
- **No telemetry.** The extension reports nothing to its author and makes no network requests of its own. The provider CLIs and tools they run may access the network according to the selected permission level.
- **The isolation gate record** is written to `~/.countersign/claude-gate.json` with owner-only permissions. It holds versions and a result, no account data.

## Hardening already in place

Real turns require a trusted workspace, one repository root and a verified platform. The diff collector refuses excluded paths, binary new files and oversized changes. Local checks are an explicit executable plus arguments, never inferred from repository scripts. Cancellation escalates from SIGTERM to SIGKILL across the process group. The webview runs under a strict Content Security Policy with nonced local scripts, and builds DOM nodes instead of parsing model output as markup.

None of this makes a filename exclusion a proof that no secret is present, or a sandbox a guarantee about every tool a model can call. The Git diff covers the repository, not external files or network actions. Treat a run as something that can read your repository, and choose Full access only when you intend to grant the provider broad host access.
