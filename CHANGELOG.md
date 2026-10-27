# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The Strict report now opens with the work instead of the paperwork: **What was implemented**, **Files changed**, **Review** and **Checks** come first, and everything that records how the result was reached — run details, hashes, budgets, sessions, timeline and usage — follows under a rule. The chat summary shows Claude's own account of the implementation, in place of the fixed sentence it printed for every clean task, followed by one line counting changed files, findings and checks.

- `countersign.cavemanStyle` decides who the Caveman terse style applies to. The internal provider exchanges are always compressed; this setting decides the text you read. `auto`, the default, follows the selected CLI profile: with the skill installed the answer is terse too, without it the answer stays full prose. `always` and `internalOnly` force either side. Strict implementation also asks for a summary written for a reader who did not watch the turn, naming each file it changed.

- Caveman Ultra now follows the installed Claude and Codex skills. Claude CLI turns read the current style rules with slash commands disabled; Claude SDK turns load only Caveman from an isolated skill plugin and report a load failure explicitly. The Claude settings gate was revised for the CLI policy.

- A Claude quota stop after Strict plan approval now offers **Change Claude account and resume**. The continuation uses the saved plan and approvals only when the current full workspace digest matches the approved baseline; it starts a fresh implementation context and retains Strict checks and review. Existing reports with a saved plan can recover their approved gate from the report. Strict reports render a short outcome and next step, with the technical detail collapsed. Phase A no longer carries objections from a replaced hash into the final plan's open objections.

- **`Strict` consensus mode**, selectable per task in the sidebar next to `Balanced` (the default). Phase A: Claude drafts a canonical plan, Claude and Codex each approve, reject or revise one plan hash, and any revision or human answer mints a new hash that voids both approvals. You then approve that exact hash, choosing **Ask before change** or **Full access**. Phase B: a fresh Claude context implements, the configured checks run, a fresh read-only Codex context reviews each snapshot digest, and Claude approves that same digest in a context with no write tools. `completed_clean` requires all of it; a disagreement, a ceiling, a stall, an unreviewable change or an unanswered question ends in a failed state with a reason and a next action.
- Strict perimeter capture: a full filesystem scan that never asks Git which files exist, so a change under a Git-ignored path such as `internal/` is still reviewed. Git supplies repository identity and the initial HEAD, nothing else. Every included file is hashed regardless of size, and files are opened without following symlinks and checked against the identity the scan saw, so neither a large file nor a swapped link can pass as unchanged.
- A single typed path policy table shared by `Balanced` and `Strict`. Policy paths (dependencies, build output, packaging artefacts) are excluded without being read and never enter the snapshot digest. Strict scans, hashes and reviews credential-named files (`.env*`, `.ssh/`, `.aws/`, `.gnupg/`, `.npmrc`, key and certificate files) like any other included file, by product decision: **a secret inside the opened folder is visible to Claude and Codex and appears in the chat report.** Balanced keeps refusing those paths, so the two modes differ here on purpose.
- Strict reports show provider requests, active time and review cycles, but do not stop automatically on those counts or on a provider-request timer. Technical bounds remain for the scanner, canonical plan, structured response and malformed-response retries; the plan's file estimate is shown at approval as information.
- **Countersign: Clear Strict interruption marker**, for the lifecycle marker a Strict task writes in workspace state. The command is unavailable while this window owns an active Strict task, asks for confirmation, and explains that removing it deletes only that metadata: it does not interrupt a task that may still be running in another window and resumes nothing.
- A Strict report covering mode, outcome and reason, every plan hash and schema version, provider and human approvals, baseline identity and digest, every reviewed snapshot digest, sessions and provider versions, findings by status, checks per round, pre-existing changes, exclusions, ceilings reached, pauses, marker state and provider usage.
- Mandatory read-only plan approval before every Balanced execution, with post-plan **Ask before change** and **Full access** choices. Ask prompts for edits, commands, network tools and configured local checks; Full access grants broad host access without further prompts.
- Sidebar chat: multiple threads per workspace, search, rename, Markdown export, interactive permission requests and diff artefacts.
- Claude and Codex model and effort catalogues read from the installed CLIs and active accounts.
- Isolation gate for the Claude SDK Ask before change path, bound to the exact installed CLI and SDK versions, with **Countersign: Verify Claude Chat Isolation**.
- The `Balanced` workflow with per-provider model and effort selection.
- One active task per repository, enforced before a turn starts and reported next to the turn settings while a task holds the lock.
- Conversation rendering: user messages on the right, agent replies on the left, with headings, lists, quotes, inline code and fenced code blocks built as DOM nodes.
- Brand assets: vector mark for the activity bar, transparent wordmark banners for light and dark themes.
- Public project documents: roadmap, security policy, contribution guide, and an account and redistribution policy for Claude and Codex.

### Changed

- Removed Strict's automatic 10-minute provider timeout, phase time and request ceilings, review-cycle ceiling, new-file size ceiling, and total diff ceiling. A stopped approved task can resume from its verified baseline with newly created untracked partial files included in the review. The sidebar no longer offers a phase A request limit.
- Fixed the disabled resume button after a finished task: chat actions now redraw when task and repository busy state changes. A failed resume preflight now shows the resume action on its own error message, including existing failures saved before this fix. Approved continuations also reconstruct tracked edits and deletions from the saved Git HEAD, so a quota stop after partial implementation can resume with the full partial diff.
- Strict reports now show Claude's cache-read and cache-write input tokens separately when reported by its CLI. The old `input_tokens` line omitted both and understated the input processed during expensive turns.
- Strict now excludes generated Python `__pycache__` directories and `.pyc`/`.pyo` files. A continuation from an older approved baseline first verifies that baseline under its original scan policy, then omits bytecode from the review; Balanced path handling is unchanged.

- Unfinished Strict reports now offer a continuation in Strict. New reports persist the last complete canonical plan in chat storage and re-evaluate it against a new baseline; older reports can supply their last readable draft as context for a new proposal. Provider and human approvals do not carry over for a planning continuation. An approved phase B stop has its separate baseline-verified resume path described above.
- Removed Countersign's per-request Claude USD guard from Strict, Balanced, chat, and their verification gates. Claude account limits still apply; usage estimates remain visible when available.
- Strict plan validation retries now carry the provider's previous structured answer and precise validation errors. Claude repairs it with repository tools disabled; both provider prompts state the exact objection reference rules. Validation events include the JSON path, so a later failure can be diagnosed without exposing provider prose in the Output Channel.
- Codex Strict plan decisions now use a schema accepted by the live CLI: every object property is required, optional fields use `null`, and unsupported string-length keywords are omitted. The local validator normalizes those nulls before checking the plan. Schema rejection is reported as a Countersign protocol error.
- When a phase's remaining active time shortens a provider request, a timeout now reports that phase ceiling and its next action instead of suggesting a change to the unrelated per-request timeout.
- Strict phase A no longer has an automatic active-time or provider-request default limit; earlier defaults cut off real consensus attempts on larger workspaces.
- Strict no longer refuses a workspace for its size. The 64 MiB aggregate scan ceiling is removed: `scan.maxScannedBytes` is gone from the limits, the scanner, the breach identifiers, the report and the tests, and no task can end because of the number of bytes a scan read. Every included file is still read and hashed in streaming, so the baseline always completes and every change stays bound to a real digest. Memory is bounded instead, by a 64 MiB per-pass diff-content pool: bytes that do not fit are dropped while the file is still hashed, binary content is dropped as soon as a NUL byte appears, and a change in a file whose bytes were not kept is reported as `content_not_retained` — unreviewable, so it blocks `completed_clean`, and distinct from `over_file_size_limit`, which is about one file's own size. A full pool never ends a task and never asks for a smaller folder or a changed setting.
- A Strict stop before phase A produces one concise chat error with the reason and next step; non-chat report callers receive a short preflight report instead of empty plan, consensus and review sections. The full report additionally states what the diff-content pool cost, as a memory bound rather than as a ceiling reached.
- Model and effort menus come from the provider's own catalogue for the signed-in account — `supportedModels()` for Claude, `model/list` for Codex — with no list kept in this project. Each model offers exactly the levels it reports, with the catalogue's labels, and the chosen value reaches the provider unchanged, so a level a verified CLI version ships works without a code change. A stored model or level the catalogue no longer offers falls back to the CLI default with a visible notice instead of failing the turn or being replaced silently. The verified-version checks are unchanged: reading the catalogue dynamically is not a promise about versions this project has never verified.

- `WorkflowResult` and workflow events are discriminated on the mode of their own run, so one conversation can hold `Balanced` and `Strict` tasks in sequence and every message and report keeps its own label. The state machine enumerates every state for both modes and shares no transition between them.
- `Balanced` keeps its behaviour unchanged: the same change source per workspace, the same `GitChangeError` semantics and the same exclusions, now derived from the shared policy table and covered by regression tests.
- Balanced accepts folders without Git and Git folders with existing changes. Clean Git folders use the diff against HEAD; dirty Git folders and ordinary folders use a bounded file snapshot from the start of the turn. Earlier Git work is excluded from Codex review and correction. No files are automatically committed, stashed or removed.
- Sidebar visual redesign: icon buttons instead of text glyphs, a single-row header, a search box that opens from the header, message bubbles, prompt cards and a composer card that follow the active VS Code theme in light and dark.
- The four model and effort selectors, the permission choice and the account line moved into a **Turn settings** panel that opens over the chat from the bar above the composer and closes with `Esc`, its **×** or a click outside. The button on that bar names the models and efforts chosen for the next turn and carries an **Ask** or **Full access** badge, so the conversation keeps the vertical space the selectors used to occupy.
- The sidebar now starts Balanced directly. Single-provider chat and custom instruction modes are removed; existing conversation messages remain readable. **Add file** now includes the selected file reference in the Balanced task.
- Snapshot stability checks hash files one at a time, avoiding a second in-memory copy of the bounded workspace contents. The plan confirmation lists up to 20 existing Git status entries; `no_changes` explains that no Codex review ran and names generated directories skipped by snapshots.
- Workflow reports name snapshot-excluded generated directories even when other files are reviewed. Provider availability is stubbed in the public-command unit test, so the suite does not depend on locally installed Claude or Codex CLIs.
- Codex receives Claude's implementation summary alongside the actual diff, so it can verify the claimed work against file changes.
- Claude's direct file tools stay inside the repository in Ask mode; approved commands and Codex escalations may reach outside it.
- Mock providers are no longer configurable in the extension. Automated tests use internal provider fakes.
- The Command Palette workflow and sidebar Balanced mode both run the real Claude and Codex pair.

### Fixed

- The conversation pane no longer collapses behind the plan and permission cards in a narrow or short sidebar; the cards keep their actions visible and the message list clips to its own area.
- Balanced now shows the actual preflight or provider startup error in the chat instead of a generic start failure.
- Dirty-workspace snapshot diffs now mark only changed lines, so earlier edits in a file touched by the task are not presented to Codex as new changes.

### Known limitations

- Linux only: macOS is unverified, and Windows execution stays blocked until process-tree cancellation exists there.
- Binary attachments are not supported; persistence across a full VS Code restart is verified at store level only.
- The repository lock coordinates one extension host, so two VS Code windows are not coordinated.
- Automatic account failover is not implemented. Strict completed a live end-to-end run with real CLIs in a temporary one-file repository; manual packaged UI use and the larger user workspace remain unverified.
- No prebuilt VSIX is published: a package bundles `@anthropic-ai/claude-agent-sdk`, which is licensed "all rights reserved". Install from source.
