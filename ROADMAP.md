# Roadmap

Countersign is a personal tool made public. This page says what exists today, what is being worked on, and what is deliberately not started. Dates are absent on purpose: items move when their exit criteria pass, not when a calendar says so.

Status vocabulary: **done** means verified by a test or a reproducible probe; **partial** means it works but at least one exit criterion is unmet; **planned** means designed but not built; **blocked** means something outside the code must happen first.

## Now (0.1.x)

| Area | Status | What is missing |
| --- | --- | --- |
| Sidebar chat: threads, search, rename, export, permissions, report and diff | partial | Binary attachments; persistence across a full VS Code restart is verified at store level only |
| Claude and Codex model discovery | partial | Catalogues are dynamic, but a full turn driven from the packaged UI is not yet covered by an automated test |
| Interactive permission prompts, cancellation, isolation gate | partial | Claude child-process termination has not been observed against a real child |
| `Balanced` workflow: Claude implements, checks run, Codex reviews, one correction pass | done | — |
| `Strict` consensus mode: plan hash agreement, human approval, snapshot digest agreement | partial | Built and covered by deterministic tests with fake providers; no live provider run and no manual click-through of its sidebar flow |
| Sidebar planning, questions, approval and detailed report for `Balanced` | partial | Read-only planning probe and automated tests pass; the complete packaged UI flow still needs a real run |
| One active task per repository | partial | The lock is in memory, so two VS Code windows on the same repository are not coordinated |
| Linux | done | — |

## Next

### 1. Platform support

**macOS.** Expected to work, not proven. Needs its own run of the isolation gate, cancellation and the packaged integration suite on an Apple machine before the manifest claims it.

**Windows — real work, not a test pass.** Workflow execution is blocked on Windows today because process-tree cancellation is not implemented there, and the chat adds more processes to manage: SDK sessions, the Codex protocol server, local checks. The work is a Windows process-group implementation (job objects or an equivalent), then the same cancellation, isolation and packaging verification the other platforms get. Until that exists and passes, Windows stays blocked rather than silently flaky.

### 2. Cross-window task lock

Replace the in-memory lock with a cross-window lock keyed by the workspace's canonical folder path, carrying the owning window's identity and stale-lock recovery after a crash. It must also work when the folder has no Git metadata. Exit criterion: two VS Code windows on the same folder cannot start concurrent tasks, proven by an integration case.

### 3. Countersign CLI

A command-line entry point that runs the same orchestration without VS Code, so the workflow can run in a terminal, over SSH, or from CI that already has the provider CLIs authenticated.

- Shares the orchestrator, providers, gates and the repository lock with the extension; no second implementation of the protocol.
- Non-interactive by default: the task, the mode, the checks and the permission policy come from flags or a config file, and anything that would open a dialog in the sidebar either fails fast or follows a declared policy.
- Prints structured events (one JSON object per line) so other tools can consume a run, with a human-readable mode for direct use.
- Same guard rails as the extension: a trusted project folder with or without Git, no credential reading, no automatic account switching, and plan approval before execution.
- Exit criteria: a run produces the same states and artefacts as the equivalent sidebar run, cancellation terminates the whole process tree, and mock cases run in CI with no provider request.

### 4. Daily use and measurement

Use the chat as the primary tool on real tasks and record turns, token usage and outcomes on sample tasks.

**Skipped as a gate, not completed.** This item was meant to gate the next one. A product decision started `Strict` without it, so the numbers it would have produced do not exist: every ceiling in `Strict` is an arbitrary placeholder, not a measured value. The item stays open, and the measurement is still the only way to replace those placeholders with cost figures.

### 5. `Strict` consensus mode

Two phases. Item 4 was skipped by decision, so this is being built without usage data. Phase A: Claude and Codex review the same canonical plan in planning contexts with no write permission, approve or reject a specific plan hash, and any edit invalidates earlier approvals. Phase B: fresh sessions implement and review, Codex approves the diff of the final snapshot and Claude approves that same snapshot against the plan. A stall, an external modification or a budget ceiling pauses the task with its history instead of reporting success. Phase A runs under a turn and time ceiling, because the realistic failure is exhausting usage limits while planning.

Status: built, in four reviewed deliveries, and selectable per task in the sidebar. What exists: the canonical plan hash and its structured-response validation, the two-provider agreement on one hash, the human approval gate that fixes the changed-file ceiling and the permission, a filesystem perimeter scan that never trusts Git for the file set, the snapshot digest every approval is bound to, the review and final-consensus loop, the in-memory pause with its lifecycle marker and its clear command, and a full report. Strict includes credential-named files in its scan and provider context. What is not verified: **no live Claude or Codex run has confirmed that real responses satisfy the structured schemas**, the sidebar flow has not been clicked through by hand, and the CLI adapters are covered only by fake runners that assert the flags they pass. Every ceiling is an arbitrary placeholder, because item 4 was skipped.

### 6. Attachments and context control

Binary and image attachments where the selected model accepts them, plus explicit control of what goes into a turn: diff ranges, file subsets, abbreviated check output with a path to the full artefact.

## Later

- **Distributing a prebuilt package.** Blocked, and not on the code: a VSIX bundles `@anthropic-ai/claude-agent-sdk`, licensed "all rights reserved", so publishing a release asset or a Marketplace listing means redistributing Anthropic's package. It needs a written answer from Anthropic, or an adapter that drives the `claude` CLI without the SDK — which currently costs interactive permission callbacks. Until then, installation is from source. See [docs/third-party-accounts.md](docs/third-party-accounts.md#redistributing-the-package-itself).
- **Marketplace listing.** After the item above, and with a listing that promises no provider access and claims no affiliation.
- **Package size.** The bundled SDK brings a full HTTP stack: roughly 8,000 files and 80 MB unpacked for an extension whose own code is a few thousand lines. Worth trimming or bundling properly before any public artefact.
- **Git worktrees for concurrent tasks.** Today the answer is one task per repository. Worktrees would carry the whole concurrency story and cannot be a prototype, so they are adopted properly or not at all.
- **Token reduction.** Measure before optimizing: incremental diffs, structured handoffs, compressed natural-language notes. Code, diffs, diagnostic output and finding evidence are never compressed.
- **More providers.** Only if a provider's CLI offers the same guarantees: user-owned authentication, interactive permissions, cancellation and a readable session model.

## Not planned

- **Single-provider chat and custom instruction modes.** Countersign's sidebar runs the Claude + Codex workflow. The providers' own extensions handle standalone conversations.
- **Automatic account failover.** An interrupted request may already have written to the repository with an unknown outcome, so resuming on another account risks applying the same change twice. The protocol that prevents that has to be written and verified before the feature can be considered, and the feature earns little in return.
- **Multiple account profiles with switching.** Out of scope until the account questions in [docs/third-party-accounts.md](docs/third-party-accounts.md) are settled; it would also require proving that profile isolation holds for both CLIs, including the system keyring.
- **Reading, copying or storing provider credentials.** Permanently excluded. Any feature that needs this is the wrong feature.
- **Hosted or managed service.** A different product under different terms.

## Influencing the roadmap

Open an issue describing the task you are trying to finish, your platform and CLI versions. Items move up when someone shows a concrete workflow they cannot complete today.
