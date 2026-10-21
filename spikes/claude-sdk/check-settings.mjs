// Local-only control for SDK settings selection. No model request.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSettings } from "@anthropic-ai/claude-agent-sdk";

const directory = await mkdtemp(join(tmpdir(), "countersign-claude-settings-"));
const uniqueCommand = `countersign-settings-control-${process.pid}`;
try {
  await mkdir(join(directory, ".claude"));
  await writeFile(join(directory, ".claude", "settings.json"), JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: uniqueCommand }] }] },
  }));
  const withProject = await resolveSettings({ cwd: directory, settingSources: ["project"] });
  const withoutFiles = await resolveSettings({ cwd: directory, settingSources: [] });
  const hasControl = (settings) => JSON.stringify(settings.effective.hooks ?? {}).includes(uniqueCommand);
  const projectHookVisible = hasControl(withProject);
  const isolatedHookAbsent = !hasControl(withoutFiles);
  console.log(JSON.stringify({ projectHookVisible, isolatedHookAbsent }));
  if (!projectHookVisible || !isolatedHookAbsent) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
