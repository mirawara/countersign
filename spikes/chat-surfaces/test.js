const assert = require("node:assert/strict");
const vscode = require("vscode");

exports.run = async () => {
  const extension = vscode.extensions.getExtension("local.countersign-chat-surfaces-spike");
  assert.ok(extension, "surface prototype extension missing");
  await extension.activate();
  await vscode.commands.executeCommand("workbench.view.extension.countersignSpike");
  await vscode.commands.executeCommand("countersignSpike.chat.focus");
  let snapshot;
  for (let attempt = 0; attempt < 40; attempt++) {
    snapshot = await vscode.commands.executeCommand("countersignSpike.snapshot");
    if (snapshot?.resolved) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(snapshot.participantRegistered, true);
  assert.equal(snapshot.resolved, true);
};
