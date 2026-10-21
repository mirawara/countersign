# Claude and Codex accounts in Countersign

Countersign drives two AI coding agents that **you** install and authenticate yourself. This page states exactly what the extension does with those accounts, what it deliberately does not do, and what is still unresolved for distributing the extension to other people. Read it before installing, and read it again before forking or redistributing.

## What the extension does

- It launches the locally installed `claude` (Claude Code) and `codex` (Codex CLI) executables as child processes, through the Claude Agent SDK and the Codex app-server protocol.
- It uses whatever login is already active for those CLIs on your machine. Authentication happens in the provider's own tool, with the provider's own login flow.
- It reports back what the provider tells it: account label, plan or quota status when exposed, model actually used, token counts, and the provider's own cost estimate.

## What the extension never does

- **No login of its own.** Countersign ships no OAuth client, no sign-in button and no account service. It cannot sign you in to Claude or ChatGPT, and it does not try.
- **No credential handling.** It does not read, copy, store, forward or display tokens, cookies, session files or API keys. There is no credential store, no secret sync and no telemetry.
- **No silent switch to metered billing.** It never sets `ANTHROPIC_API_KEY`, never uses `--bare` (whose help states that Anthropic authentication then comes only from an API key or `apiKeyHelper`, with OAuth and keychain ignored), and never substitutes pay-per-use API credentials for a subscription seat.
- **No quota circumvention.** There is no account rotation, no automatic failover between accounts and no retry designed to get around a usage limit. When a limit is reached, the turn stops and says so.

## Costs and limits are yours

Running a turn consumes whatever the provider charges your account: subscription usage limits, API credits, or both. US dollar figures that appear in the chat are **estimates the CLI computes at API list prices**; on a subscription seat they do not correspond to a charge. Countersign's time and budget settings are guard rails for the extension's own loop, not billing caps enforced by the provider. Verify consumption in your Anthropic and OpenAI account dashboards, not here.

## Using the extension (personal use)

The public sources of both providers were reviewed on 21 October 2026 for the case this repository actually implements: a person running their own authenticated CLIs on their own machine.

- Anthropic's [plan guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) states that the Agent SDK, `claude -p` and third-party applications can use Claude subscription limits.
- OpenAI documents [Codex CLI authentication](https://learn.chatgpt.com/docs/auth) with a ChatGPT login whose credentials live in `CODEX_HOME` or the system keyring.

Nothing in Countersign changes how either CLI authenticates, so using it is governed by your own agreement with Anthropic and with OpenAI. If your plan, organization policy or employer forbids driving those CLIs from another tool, do not use this one.

## Redistribution: the open question

**This is the part to get right before building a product on top of this repository.**

Anthropic's [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) states that, without prior approval, third-party developers may not offer claude.ai login or claude.ai usage limits inside their own products. Countersign ships no login or account service: the user brings a CLI they have already authenticated. It does, however, use the Agent SDK and display provider-reported quota status. The published guidance does not settle whether distributing this particular combination to other users is permitted. The review in this repository establishes a personal-use case, not clearance to distribute the extension.

OpenAI treats the equivalent case separately. [Sign in with ChatGPT](https://developers.openai.com/siwc/quickstart) distinguishes open-source applications from selected commercial partners, and its [app-server token-sharing guide](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) expects the application to run its own OAuth flow and manage tokens. Countersign does neither, and reusing the CLI's stored token file as a shortcut to an in-product login is explicitly out of scope.

Consequences for anyone redistributing this code:

1. **Publishing this source repository** does not include the SDK package or a prebuilt extension. It does not establish that a VSIX may be distributed or that third-party use of the existing Claude integration has been cleared.
2. **Distributing a VSIX or listing the extension** needs a separate review of the SDK's redistribution terms and Anthropic's account rules. Obtain a written answer for the intended distribution and authentication model before releasing a package. A listing must not promise provider access or imply an affiliation.
3. **Adding an in-product Claude login or offering claude.ai usage limits** requires Anthropic's prior approval under its published Agent SDK guidance.
4. **Adding a ChatGPT login requires choosing and qualifying for one of OpenAI's documented paths**, with your own OAuth client and token handling, under the terms attached to that path.
5. **Offering Countersign as a hosted or managed service**, where your infrastructure holds or proxies anyone's provider credentials, is a different product with different terms, and none of the review above covers it.

The evidence and version-by-version results behind these statements are in [verification.md](verification.md). That review concluded **permitted with limits for personal use**; it did not clear distribution with provider login or usage limits, and no later work in this repository has changed that.

## Redistributing the package itself

Separate from account terms, and easy to miss: a VSIX built from this repository **bundles `@anthropic-ai/claude-agent-sdk`**, because the chat adapter imports it at runtime for interactive permission callbacks. That package ships its own licence:

> © Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance

"All rights reserved" is not a redistribution grant. Apache-2.0 covers the code in this repository; it does not and cannot cover a bundled third-party dependency. Practical consequences:

- **Installing from source is the supported path.** `npm install` fetches the SDK from npm directly, so each user receives it from Anthropic under Anthropic's own terms. Nothing is re-published.
- **Publishing a prebuilt `.vsix`** (a GitHub release asset, a Marketplace listing, an internal artefact server) means distributing Anthropic's package inside your artefact. Check [Anthropic's legal agreements](https://code.claude.com/docs/en/legal-and-compliance), and get a written answer, before doing that. This repository does not assume the answer is yes.
- **A dependency-free path would remove the question.** Driving the `claude` CLI directly, without the SDK, is possible for turns with a fixed allowlist, but the CLI's headless documentation points to the SDK packages for tool-approval callbacks, which is exactly what the chat needs. Dropping the SDK therefore costs interactive permissions until an equivalent CLI mechanism exists.

The same reasoning applies to every other dependency vsce bundles: check a licence before you ship someone else's bytes.

## Trademarks and affiliation

Countersign is an independent project. It is not affiliated with, endorsed by or sponsored by Anthropic or OpenAI. Claude, Claude Code, Anthropic, ChatGPT, Codex and OpenAI are trademarks of their respective owners, used here only to say which tools the extension drives.
