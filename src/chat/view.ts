import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

/** Stroke icons drawn inline so the webview needs no image source beyond the extension itself. */
const stroke = (body: string): string =>
  `<svg class="i" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

const icon = {
  plus: stroke(`<path d="M8 3.4v9.2M3.4 8h9.2"/>`),
  pencil: stroke(`<path d="M11.1 2.4 13.6 4.9 6 12.5l-3.3.8.8-3.3z"/>`),
  download: stroke(`<path d="M8 2.4v7.4M5 6.9 8 9.9l3-3M3 13.3h10"/>`),
  trash: stroke(`<path d="M2.9 4.2h10.2M6.4 4.2V2.8h3.2v1.4M4.5 4.2l.6 9h5.8l.6-9"/>`),
  search: stroke(`<circle cx="7.1" cy="7.1" r="3.9"/><path d="M10 10l3.2 3.2"/>`),
  sliders: stroke(`<path d="M2.6 5.2h2.9M8.5 5.2h4.9M2.6 10.8h4.9M10.5 10.8h2.9"/><circle cx="7" cy="5.2" r="1.5"/><circle cx="9" cy="10.8" r="1.5"/>`),
  chevron: stroke(`<path d="M5.4 6.4 8 9l2.6-2.6"/>`),
  refresh: stroke(`<path d="M13 8a5 5 0 1 1-1.8-3.8"/><path d="M13.2 2.3v3h-3"/>`),
  send: stroke(`<path d="M13.8 2.2 7.2 8.8M13.8 2.2 9.6 13.8 7.2 8.8 2.2 6.4z"/>`),
  stop: stroke(`<rect x="4.5" y="4.5" width="7" height="7" rx="1.4"/>`),
  shield: stroke(`<path d="M8 2.2 12.9 4v4c0 3-2.1 5-4.9 5.8C5.2 13 3.1 11 3.1 8V4z"/><path d="M6.1 8.1 7.4 9.4l2.5-2.6"/>`),
  question: stroke(`<circle cx="8" cy="8" r="5.8"/><path d="M6.4 6.3a1.6 1.6 0 1 1 1.9 1.8v1.1"/><path d="M8.3 11.4h.01"/>`),
  close: stroke(`<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>`),
};

const mark = (size: number, className: string): string =>
  `<svg class="${className}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 1.2Q12 5.01 15.77 5.01Q12 5.01 12 7.81Q12 5.01 8.23 5.01Q12 5.01 12 1.2ZM12 7.81Q12 12.89 18.28 12.89Q12 12.89 12 22.8Q12 12.89 5.72 12.89Q12 12.89 12 7.81Z"/></svg>`;

export class ChatView implements vscode.WebviewViewProvider {
  static readonly viewType = "countersign.chat";
  private view: vscode.WebviewView | undefined;
  private ready = false;
  private lastRecovery = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (message: unknown) => void,
    private readonly onReady: () => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (typeof message === "object" && message !== null && "type" in message && message.type === "ready") {
        this.ready = true;
        this.onReady();
      } else if (typeof message === "object" && message !== null && "type" in message && message.type === "uiError") {
        this.recover();
      } else {
        this.onMessage(message);
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.onReady();
        setTimeout(() => { if (this.view === view && view.visible) this.onReady(); }, 100);
      }
    });
    view.onDidDispose(() => { if (this.view === view) this.view = undefined; });
    view.webview.html = this.html(view.webview, media);
    setTimeout(() => { if (this.view === view && view.visible && !this.ready) this.recover(); }, 5_000);
  }

  private recover(): void {
    const view = this.view;
    if (!view || Date.now() - this.lastRecovery < 60_000) return;
    this.lastRecovery = Date.now();
    this.ready = false;
    view.webview.html = this.html(view.webview, vscode.Uri.joinPath(this.extensionUri, "media"));
  }

  post(message: unknown): void {
    if (this.view) void this.view.webview.postMessage(message);
  }

  get resolved(): boolean { return Boolean(this.view); }

  reveal(): void {
    if (this.view) this.view.show(true);
    else void vscode.commands.executeCommand("workbench.view.extension.countersign");
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString("base64");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.css"));
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}"><title>Countersign Chat</title></head>
<body>
<header class="app-header">
<div class="brand">${mark(16, "brand-mark")}<span class="brand-name">Countersign</span></div>
<div class="header-actions">
<button id="search-toggle" class="icon" title="Search conversations" aria-label="Search conversations">${icon.search}</button>
<button id="new-thread" class="icon" title="New conversation" aria-label="New conversation">${icon.plus}</button>
<button id="rename-thread" class="icon" title="Rename conversation" aria-label="Rename conversation">${icon.pencil}</button>
<button id="export-thread" class="icon" title="Export conversation" aria-label="Export conversation">${icon.download}</button>
<button id="delete-thread" class="icon danger" title="Delete conversation" aria-label="Delete conversation">${icon.trash}</button>
</div></header>

<div class="thread-bar">
<label class="sr-only" for="thread">Conversation</label>
<span class="select"><select id="thread"></select></span>
<div id="search-row" class="search hidden">${icon.search}<label class="sr-only" for="search">Search conversations</label>
<input id="search" type="search" placeholder="Search conversations"></div>
</div>

<div id="notice" role="status" aria-live="polite"></div>

<main class="conversation">
<div id="messages" role="log" aria-label="Conversation" aria-live="polite"></div>
<div id="empty" class="empty hidden">${mark(34, "empty-mark")}<h2>Two agents, one countersigned diff</h2>
<p>Describe a task below. Claude implements it, any checks you configured run, Codex reviews the diff.</p></div>
</main>

<section id="approval" class="card warn hidden" aria-label="Permission request">
<div class="card-head">${icon.shield}<strong>Permission requested</strong></div>
<p id="approval-summary"></p><pre id="approval-detail"></pre>
<div class="card-actions"><button id="approve" class="primary">Allow once</button><button id="deny">Deny</button>
<button id="cancel-approval" class="quiet">Cancel turn</button></div></section>

<section id="workflow-prompt" class="card hidden" aria-label="Workflow response">
<div class="card-head">${icon.question}<strong id="workflow-title"></strong></div>
<p id="workflow-detail"></p>
<label id="workflow-answer-label" class="hidden">Your answer<textarea id="workflow-answer" rows="3"></textarea></label>
<div id="strict-controls" class="strict-controls hidden">
<label>After approval<span class="select"><select id="strict-permission">
<option value="askBeforeChange">Ask before change</option><option value="fullAccess">Full access</option>
</select></span></label>
<p id="strict-hint" class="hint"></p>
</div>
<div class="card-actions"><button id="workflow-submit" class="primary"></button>
<button id="workflow-secondary" class="quiet hidden"></button>
<button id="workflow-cancel" class="quiet">Cancel workflow</button></div></section>

<div id="settings-scrim" class="scrim hidden"></div>

<footer>
<div class="turn-bar">
<button id="settings-toggle" class="settings-toggle" aria-expanded="false" title="Models, effort and permission for the next turn">
${icon.sliders}<span id="settings-digest" class="digest"></span><span id="settings-perm" class="perm"></span></button>
<div id="repo-lock" class="repo-lock" role="status" aria-live="polite"></div>
</div>

<section id="settings" class="sheet hidden" aria-label="Turn settings">
<div class="sheet-head">${icon.sliders}<strong>Turn settings</strong>
<button id="settings-close" class="icon" title="Close turn settings" aria-label="Close turn settings">${icon.close}</button></div>
<div class="sheet-body">
<div class="agent-card">
<div class="agent-head"><span class="dot claude"></span>Claude<span class="agent-role">implements</span></div>
<label>Account<span class="select"><select id="claude-account" aria-label="Claude account"></select></span></label>
<div id="claude-email" class="account-identity" role="status">Email unavailable</div>
<div id="claude-usage" class="account-usage" role="status">Usage unavailable</div>
<div class="account-actions"><button id="add-claude-account" class="quiet" aria-label="Add Claude account">Add</button><button id="login-claude-account" class="quiet" aria-label="Sign in to Claude account">Sign in</button><button id="remove-claude-account" class="quiet" aria-label="Remove Claude account from selector">Remove</button></div>
<label>Model<span class="select"><select id="balanced-claude-model"></select></span></label>
<label>Effort<span class="select"><select id="balanced-claude-effort"></select></span></label>
</div>
<div class="agent-card">
<div class="agent-head"><span class="dot codex"></span>Codex<span class="agent-role">reviews</span></div>
<label>Account<span class="select"><select id="codex-account" aria-label="Codex account"></select></span></label>
<div id="codex-email" class="account-identity" role="status">Email unavailable</div>
<div id="codex-usage" class="account-usage" role="status">Usage unavailable</div>
<div class="account-actions"><button id="add-codex-account" class="quiet" aria-label="Add Codex account">Add</button><button id="login-codex-account" class="quiet" aria-label="Sign in to Codex account">Sign in</button><button id="remove-codex-account" class="quiet" aria-label="Remove Codex account from selector">Remove</button></div>
<label>Model<span class="select"><select id="balanced-codex-model"></select></span></label>
<label>Reasoning<span class="select"><select id="balanced-codex-effort"></select></span></label>
</div>
<label class="wide">Mode<span class="select"><select id="mode">
<option value="balanced">Balanced</option><option value="strict">Strict</option>
</select></span></label>
<label class="wide">After plan approval<span class="select"><select id="execution-permission">
<option value="askBeforeChange">Ask before change</option><option value="fullAccess">Full access</option>
</select></span></label>
<p id="selection-notice" class="selection-notice hidden" role="status" aria-live="polite"></p>
<div class="account-line"><span id="account">Account: unavailable</span>
<button id="refresh" class="icon" title="Refresh providers" aria-label="Refresh providers">${icon.refresh}</button></div>
</div></section>

<div id="attachment" class="attachment hidden"></div>
<div class="composer">
<label class="sr-only" for="prompt">Task</label>
<textarea id="prompt" rows="4" placeholder="Describe a task for Claude to implement and Codex to review"></textarea>
<div class="compose-actions">
<span class="spacer"></span>
<button id="stop" class="icon danger hidden" title="Stop the running task" aria-label="Stop the running task">${icon.stop}</button>
<button id="send" class="primary">${icon.send}<span id="send-label">Start workflow</span></button>
</div></div></footer>

<script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
}
