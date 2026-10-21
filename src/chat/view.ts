import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export class ChatView implements vscode.WebviewViewProvider {
  static readonly viewType = "countersign.chat";
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (message: unknown) => void,
    private readonly onReady: () => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (typeof message === "object" && message !== null && "type" in message && message.type === "ready") {
        this.onReady();
      } else {
        this.onMessage(message);
      }
    });
    view.onDidDispose(() => { if (this.view === view) this.view = undefined; });
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
<header><div class="brand"><svg class="brand-mark" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 1.2Q12 5.01 15.77 5.01Q12 5.01 12 7.81Q12 5.01 8.23 5.01Q12 5.01 12 1.2ZM12 7.81Q12 12.89 18.28 12.89Q12 12.89 12 22.8Q12 12.89 5.72 12.89Q12 12.89 12 7.81Z"/></svg><strong>Countersign</strong></div>
<div class="thread-bar"><label class="sr-only" for="thread">Conversation</label><select id="thread"></select>
<button id="new-thread" title="New conversation" aria-label="New conversation">＋</button>
<button id="rename-thread" title="Rename conversation" aria-label="Rename conversation">✎</button>
<button id="export-thread" title="Export conversation" aria-label="Export conversation">⇩</button>
<button id="delete-thread" title="Delete conversation" aria-label="Delete conversation">⌫</button></div></header>
<label class="sr-only" for="search">Search conversations</label><input id="search" type="search" placeholder="Search conversations">
<section class="controls" aria-label="Turn settings">
<label class="mode-label">Mode<select id="mode"></select></label>
<label>Provider<select id="provider"></select></label>
<label>Model<select id="model"></select></label>
<label>Effort<select id="effort"></select></label>
<div id="balanced-options" class="balanced-options hidden">
<label>Claude model<select id="balanced-claude-model"></select></label>
<label>Claude effort<select id="balanced-claude-effort"></select></label>
<label>Codex model<select id="balanced-codex-model"></select></label>
<label>Codex reasoning<select id="balanced-codex-effort"></select></label>
</div>
<div class="mode-actions"><button id="add-mode" title="Define a chat mode">Add mode</button><button id="delete-mode" title="Delete selected custom mode">Delete mode</button></div>
<div class="account-line"><span id="account">Account: unavailable</span><button id="refresh" title="Refresh providers">Refresh</button></div>
<div id="repo-lock" class="repo-lock" role="status" aria-live="polite"></div>
</section>
<div id="notice" role="status" aria-live="polite"></div>
<main id="messages" role="log" aria-label="Conversation" aria-live="polite"></main>
<section id="approval" class="approval hidden" aria-label="Permission request"><strong>Permission requested</strong><p id="approval-summary"></p><pre id="approval-detail"></pre>
<div class="approval-actions"><button id="approve">Allow once</button><button id="deny">Deny</button><button id="cancel-approval">Cancel turn</button></div></section>
<section id="workflow-prompt" class="approval hidden" aria-label="Workflow response"><strong id="workflow-title"></strong>
<p id="workflow-detail"></p><label id="workflow-answer-label" class="hidden">Your answer<textarea id="workflow-answer" rows="3"></textarea></label>
<div class="approval-actions"><button id="workflow-submit" class="primary"></button><button id="workflow-cancel">Cancel workflow</button></div></section>
<footer><div id="attachment" class="attachment hidden"></div>
<label class="sr-only" for="prompt">Message</label><textarea id="prompt" rows="4" placeholder="Ask Claude or Codex about this repository"></textarea>
<div class="compose-actions"><button id="add-file" title="Reference the active file or selection">Add file</button><span class="spacer"></span><button id="stop" class="hidden">Stop</button><button id="send" class="primary">Send</button></div></footer>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
}
