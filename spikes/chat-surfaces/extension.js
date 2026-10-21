const vscode = require("vscode");
const { randomBytes } = require("node:crypto");

let resolved = false;
let participantRegistered = false;
let messageReceived = false;

exports.activate = (context) => {
  const participant = vscode.chat.createChatParticipant("countersign-spike.agent", async (_request, _chatContext, stream) => {
    stream.progress("Mock turn");
    stream.markdown("Mock streaming response.");
  });
  participantRegistered = true;
  const provider = {
    resolveWebviewView(view) {
      resolved = true;
      const nonce = randomBytes(16).toString("base64");
      view.webview.options = { enableScripts: true, localResourceRoots: [] };
      view.webview.html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'"></head><body>
        <label>Provider <select id="provider"><option>Mock Claude</option><option>Mock Codex</option></select></label>
        <label>Mode <select id="mode"><option>Balanced</option><option>Custom</option></select></label>
        <button id="send">Send mock turn</button>
        <script nonce="${nonce}">const api=acquireVsCodeApi();document.getElementById('send').onclick=()=>api.postMessage({type:'sendMock'});</script>
      </body></html>`;
      view.webview.onDidReceiveMessage((message) => { if (message?.type === "sendMock") messageReceived = true; });
    },
  };
  context.subscriptions.push(participant, vscode.window.registerWebviewViewProvider("countersignSpike.chat", provider),
    vscode.commands.registerCommand("countersignSpike.snapshot", () => ({ resolved, participantRegistered, messageReceived })));
};
