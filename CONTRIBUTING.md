# Contributing

Thanks for looking. Countersign is a small, opinionated tool; the fastest way to get a change merged is to match the constraints it is built around.

## Ground rules

1. **No credential handling.** Nothing may read, copy, store, display or transmit tokens, cookies, session files or API keys. A feature that needs this is the wrong feature.
2. **No implicit permissions.** A write or a command runs only after an explicit request the user answered. A model's text is never treated as authorization, and a command a model proposes is never executed automatically.
3. **No provider login inside the extension.** See [docs/third-party-accounts.md](docs/third-party-accounts.md). This is a terms constraint, not a style preference.
4. **No live calls from automated tests.** `npm test` and the default integration cases must never send a provider request. Live probes live in `scripts/`, require `--live`, and run by hand on temporary repositories.
5. **Claims need evidence.** If a pull request says a capability works, say which version you tested and how someone reproduces it. `docs/verification.md` is the model: version, command, result, limit.

## Setup

```sh
npm install
npm run compile
npm run lint
npm test
```

Press <kbd>F5</kbd> in VS Code for an Extension Development Host. `npm run package` builds the VSIX.

Integration cases use the committed templates in `tests/integration/fixtures/`; the runner copies them to the work directory and initializes temporary Git repositories with baseline commits. They need a display:

```sh
npm run test:integration -- --work=/tmp/countersign-integration
```

On headless Linux, run the suite under Xvfb with `xvfb-run -a npm run test:integration -- --work=/tmp/countersign-integration`. The `cancel-during-check` template starts a check that spawns a child process; the case verifies cancellation stops both processes. The default suite uses mock providers and sends no provider requests; CI runs it under Xvfb.

## Code style

- TypeScript, strict. `npm run lint` and `npm run compile` must pass.
- Match the surrounding code: same naming, same comment density. Comments explain *why*, not *what*.
- The webview builds DOM nodes; never assign `innerHTML` or inject provider output as markup.
- Keep the Content Security Policy strict: local scripts with a nonce, no remote resources.
- User-visible strings are English, in the extension and in its logs.

## Tests

- Unit tests (`vitest`) cover providers, orchestration, storage and the webview script through a DOM double.
- Add a test with behavioural changes. Rendering changes go through the DOM double rather than a screenshot.
- Integration cases cover activation, commands and the packaged manifest. Add one when a change affects how VS Code loads or registers something.

## Pull requests

- One topic per pull request, with a description of what you verified and on which platform, CLI and SDK versions.
- Say explicitly if something is unverified. "Works on my machine, not tested on macOS" is a useful sentence; silence is not.
- Documentation lives with the change: a new setting or command updates the README and the relevant guide in the same pull request.

## Reporting bugs

Open an issue with your OS, VS Code version, extension version, Claude Code and Codex CLI versions, and the steps. Strip anything proprietary from logs and diffs before pasting them — the extension does not redact them for you.

Security problems go to [SECURITY.md](SECURITY.md) instead, not to the issue tracker.
