(() => {
  "use strict";
  const api = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);
  const dom = Object.fromEntries([
    "thread", "new-thread", "rename-thread", "export-thread", "delete-thread", "search", "provider", "model", "effort", "mode", "add-mode", "delete-mode", "account", "refresh", "repo-lock",
    "balanced-options", "balanced-claude-model", "balanced-claude-effort", "balanced-codex-model", "balanced-codex-effort",
    "notice", "messages", "approval", "approval-summary", "approval-detail", "approve", "deny", "cancel-approval",
    "workflow-prompt", "workflow-title", "workflow-detail", "workflow-answer-label", "workflow-answer", "workflow-submit", "workflow-cancel",
    "attachment", "prompt", "add-file", "stop", "send",
  ].map((id) => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), el(id)]));
  let state = null;
  let capabilities = [];
  let modes = [{ id: "chat", label: "Chat" }];
  let busy = false;
  let repositoryBusy = false;
  let approval = null;
  let workflowPrompt = null;
  let workflowPromptId = "";
  let attachment = null;
  let notice = "";
  const selectedModels = {};
  const selectedEfforts = {};
  const balancedSelection = { claudeModel: "", claudeEffort: "", codexModel: "", codexEffort: "" };

  const post = (message) => api.postMessage(message);
  const option = (value, label) => {
    const node = document.createElement("option");
    node.value = value;
    node.textContent = label;
    return node;
  };
  const node = (tag, className, text) => {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
  };
  const providerLabel = (provider) => provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : provider;
  const currentCapability = () => capabilities.find((entry) => entry.provider === dom.provider.value);
  const currentModel = () => currentCapability()?.models.find((entry) => entry.value === dom.model.value);

  function renderSelectors() {
    const fallback = capabilities.find((entry) => entry.available)?.provider || capabilities[0]?.provider || "";
    const provider = dom.provider.value || fallback;
    dom.provider.replaceChildren(...capabilities.map((entry) => option(entry.provider, providerLabel(entry.provider))));
    dom.provider.value = capabilities.some((entry) => entry.provider === provider) ? provider : fallback;
    const capability = currentCapability();
    const previousModel = selectedModels[dom.provider.value] || dom.model.value;
    dom.model.replaceChildren(...(capability?.models ?? []).map((entry) => option(entry.value, entry.label)));
    if (capability?.models.some((entry) => entry.value === previousModel)) dom.model.value = previousModel;
    selectedModels[dom.provider.value] = dom.model.value;
    renderEfforts();
    const mode = dom.mode.value || "chat";
    dom.mode.replaceChildren(...modes.map((entry) => option(entry.id, entry.label)));
    dom.mode.value = modes.some((entry) => entry.id === mode) ? mode : modes[0]?.id || "chat";
    const selectedMode = modes.find((entry) => entry.id === dom.mode.value);
    const balanced = selectedMode?.protocol === "balanced";
    dom.addMode.disabled = busy;
    dom.deleteMode.disabled = busy || !selectedMode?.id.startsWith("custom-");
    dom.provider.disabled = balanced;
    dom.model.disabled = balanced;
    dom.effort.disabled = balanced;
    for (const control of [dom.provider, dom.model, dom.effort]) control.parentElement.classList.toggle("hidden", balanced);
    dom.balancedOptions.classList.toggle("hidden", !balanced);
    if (balanced) renderBalancedSelectors();
    dom.account.textContent = balanced
      ? `Real task · ${["claude", "codex"].map((name) => {
        const info = capabilities.find((entry) => entry.provider === name);
        return info?.models.length ? `${providerLabel(name)}: ${info.models.length} models`
          : `${providerLabel(name)}: ${info?.reason || "Refresh to load models"}`;
      }).join(" · ")}`
      : capability?.available
      ? `Account: ${capability.accountLabel}${capability.version ? ` · ${capability.version}` : ""}${capability.quotaLabel ? ` · Quota: ${capability.quotaLabel}` : ""}`
      : `Account: ${capability?.reason || "Unavailable"}`;
    dom.repoLock.textContent = busy
      ? "A Countersign task is running in this chat."
      : repositoryBusy
        ? "Repository busy: another Countersign task is active in this VS Code window."
        : "One Countersign task at a time per repository in this VS Code window.";
    dom.send.disabled = busy || repositoryBusy || (!balanced && !capability?.available);
    dom.send.textContent = balanced ? "Start workflow" : "Send";
    dom.stop.classList.toggle("hidden", !busy);
  }

  function renderEfforts() {
    const levels = currentModel()?.effortLevels ?? [];
    const key = `${dom.provider.value}:${dom.model.value}`;
    const previous = selectedEfforts[key] || dom.effort.value;
    dom.effort.replaceChildren(option("", "Default"), ...levels.map((level) => option(level, level)));
    dom.effort.value = levels.includes(previous) ? previous : "";
    selectedEfforts[key] = dom.effort.value;
  }

  function renderBalancedSelectors() {
    for (const provider of ["claude", "codex"]) {
      const name = provider === "claude" ? "Claude" : "Codex";
      const modelKey = `${provider}Model`;
      const effortKey = `${provider}Effort`;
      const modelControl = dom[`balanced${name}Model`];
      const effortControl = dom[`balanced${name}Effort`];
      const models = (capabilities.find((entry) => entry.provider === provider)?.models ?? [])
        .filter((entry) => entry.value !== "default");
      modelControl.replaceChildren(option("", "Default (CLI)"), ...models.map((entry) => option(entry.value, entry.label)));
      if (models.some((entry) => entry.value === balancedSelection[modelKey])) modelControl.value = balancedSelection[modelKey];
      else balancedSelection[modelKey] = "";
      modelControl.disabled = busy;
      const selected = models.find((entry) => entry.value === modelControl.value);
      const levels = (selected?.effortLevels ?? []).filter((level) => provider !== "claude" ||
        ["low", "medium", "high", "max"].includes(level));
      effortControl.replaceChildren(option("", "Default (CLI)"), ...levels.map((level) => option(level, level)));
      if (levels.includes(balancedSelection[effortKey])) effortControl.value = balancedSelection[effortKey];
      else balancedSelection[effortKey] = "";
      effortControl.disabled = !selected || busy;
    }
  }

  function renderThreads() {
    const current = state?.activeThreadId;
    const query = dom.search.value.trim().toLowerCase();
    const threads = (state?.threads ?? []).filter((thread) => !query || thread.title.toLowerCase().includes(query) ||
      thread.messages.some((message) => message.text.toLowerCase().includes(query)));
    dom.thread.replaceChildren(...threads.map((thread) => option(thread.id, thread.title)));
    if (current) dom.thread.value = current;
    dom.deleteThread.disabled = busy || !current;
    dom.renameThread.disabled = busy || !current;
    dom.exportThread.disabled = !current;
    dom.newThread.disabled = busy;
  }

  /** Inline spans: `code`, **strong**, *emphasis*. Text only; no HTML is ever parsed. */
  function inlineNodes(text) {
    const nodes = [];
    const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)/g;
    let index = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      if (match.index > index) nodes.push(node("span", "", text.slice(index, match.index)));
      const token = match[0];
      if (token.startsWith("`")) nodes.push(node("code", "inline-code", token.slice(1, -1)));
      else if (token.startsWith("**")) nodes.push(node("strong", "", token.slice(2, -2)));
      else nodes.push(node("em", "", token.slice(1, -1)));
      index = match.index + token.length;
    }
    if (index < text.length) nodes.push(node("span", "", text.slice(index)));
    return nodes.length ? nodes : [node("span", "", text)];
  }

  function paragraph(lines) {
    const block = node("p", "para");
    for (const part of inlineNodes(lines.join("\n"))) block.append(part);
    return block;
  }

  function codeBlock(language, lines) {
    const block = node("div", "code-block");
    if (language) block.append(node("div", "code-language", language));
    block.append(node("pre", "", lines.join("\n")));
    return block;
  }

  function listBlock(items, ordered) {
    const list = node(ordered ? "ol" : "ul", "list");
    for (const item of items) {
      const entry = node("li");
      for (const part of inlineNodes(item)) entry.append(part);
      list.append(entry);
    }
    return list;
  }

  /** Renders the subset of Markdown the agents actually emit, building nodes instead of HTML. */
  function markdownNodes(text) {
    const blocks = [];
    const lines = text.split("\n");
    let paragraphLines = [];
    let listItems = [];
    let listOrdered = false;
    const flush = () => {
      if (paragraphLines.length) { blocks.push(paragraph(paragraphLines)); paragraphLines = []; }
      if (listItems.length) { blocks.push(listBlock(listItems, listOrdered)); listItems = []; }
    };
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const fence = /^\s*```(\w+)?\s*$/.exec(line);
      if (fence) {
        flush();
        const body = [];
        index += 1;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) { body.push(lines[index]); index += 1; }
        blocks.push(codeBlock(fence[1] || "", body));
        continue;
      }
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        flush();
        const level = Math.min(heading[1].length + 2, 6);
        const title = node(`h${level}`, "heading");
        for (const part of inlineNodes(heading[2])) title.append(part);
        blocks.push(title);
        continue;
      }
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (bullet || numbered) {
        if (paragraphLines.length) { blocks.push(paragraph(paragraphLines)); paragraphLines = []; }
        const ordered = Boolean(numbered);
        if (listItems.length && ordered !== listOrdered) { blocks.push(listBlock(listItems, listOrdered)); listItems = []; }
        listOrdered = ordered;
        listItems.push((bullet ? bullet[1] : numbered[1]));
        continue;
      }
      const quote = /^\s*>\s?(.*)$/.exec(line);
      if (quote) {
        flush();
        const block = node("blockquote", "quote");
        for (const part of inlineNodes(quote[1])) block.append(part);
        blocks.push(block);
        continue;
      }
      if (!line.trim()) { flush(); continue; }
      if (listItems.length) { blocks.push(listBlock(listItems, listOrdered)); listItems = []; }
      paragraphLines.push(line);
    }
    flush();
    return blocks;
  }

  const authorLabel = (message) => message.role === "user" ? "You"
    : message.role === "system" ? "Countersign"
    : message.modeLabel?.includes("Balanced") ? "Balanced workflow"
    : providerLabel(message.provider) || "Agent";

  function timeLabel(value) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "";
    const hours = String(parsed.getHours()).padStart(2, "0");
    const minutes = String(parsed.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  }

  function detailChips(message) {
    return [message.modeLabel, message.accountLabel,
      message.requestedModel && message.requestedModel !== message.model ? `selected: ${message.requestedModel}` : null,
      message.model ? `model: ${message.model}` : null,
      message.requestedEffort ? `effort requested: ${message.requestedEffort}` : null,
      message.effectiveEffort ? `effective: ${message.effectiveEffort}` : null,
      message.usage?.inputTokens !== undefined
        ? `${message.usage.inputTokens} in · ${message.usage.outputTokens ?? "?"} out` : null,
      message.usage?.estimatedCostUsd !== undefined
        ? `$${message.usage.estimatedCostUsd.toFixed(3)} API price estimate` : null,
      message.quota?.status ? `quota: ${message.quota.status}${message.quota.type ? ` (${message.quota.type})` : ""}` : null,
    ].filter(Boolean);
  }

  function messageNode(message) {
    const row = node("article", `row ${message.role}`);
    const bubble = node("div", "bubble");
    const head = node("div", "head");
    head.append(node("span", "who", authorLabel(message)));
    if (message.status && message.status !== "completed") head.append(node("span", `status ${message.status}`, message.status));
    head.append(node("span", "time", timeLabel(message.createdAt)));
    bubble.append(head);
    const body = node("div", "body");
    if (message.text) for (const block of markdownNodes(message.text)) body.append(block);
    else if (message.status === "running") body.append(node("span", "typing", "Working…"));
    bubble.append(body);
    const chips = detailChips(message);
    if (chips.length) {
      const meta = node("div", "meta");
      for (const chip of chips) meta.append(node("span", "chip", chip));
      bubble.append(meta);
    }
    if (message.fileRefs?.length) {
      const files = node("div", "files");
      for (const path of message.fileRefs) files.append(node("span", "chip file", path));
      bubble.append(files);
    }
    if (message.activity?.length) {
      const details = node("details", "activity");
      details.append(node("summary", "", `Activity (${message.activity.length})`));
      details.append(node("pre", "", message.activity.slice(-40).join("\n")));
      bubble.append(details);
    }
    if (message.diffArtifact) {
      const actions = node("div", "bubble-actions");
      const open = node("button", "", "Show diff");
      open.addEventListener("click", () => post({ type: "openDiff", messageId: message.id }));
      actions.append(open);
      bubble.append(actions);
    }
    row.append(bubble);
    return row;
  }

  function renderMessages() {
    const thread = state?.threads.find((entry) => entry.id === state.activeThreadId);
    const nearBottom = dom.messages.scrollHeight - dom.messages.scrollTop - dom.messages.clientHeight < 70;
    if (!thread?.messages.length) {
      dom.messages.replaceChildren(node("p", "empty", "Start a conversation about this repository."));
    } else {
      dom.messages.replaceChildren(...thread.messages.map(messageNode));
    }
    if (nearBottom) dom.messages.scrollTop = dom.messages.scrollHeight;
  }

  function renderApproval() {
    dom.approval.classList.toggle("hidden", !approval);
    dom.approvalSummary.textContent = approval?.summary || "";
    dom.approvalDetail.textContent = approval?.detail || "";
  }

  function renderWorkflowPrompt() {
    dom.workflowPrompt.classList.toggle("hidden", !workflowPrompt);
    if (!workflowPrompt) { workflowPromptId = ""; return; }
    if (workflowPrompt.id !== workflowPromptId) {
      dom.workflowAnswer.value = "";
      workflowPromptId = workflowPrompt.id;
    }
    dom.workflowTitle.textContent = workflowPrompt.title;
    dom.workflowDetail.textContent = workflowPrompt.detail;
    const question = workflowPrompt.kind === "question";
    dom.workflowAnswerLabel.classList.toggle("hidden", !question);
    dom.workflowSubmit.textContent = question ? "Send answer" : "Approve plan";
    dom.workflowSubmit.disabled = question && !dom.workflowAnswer.value.trim();
  }

  function renderAttachment() {
    dom.attachment.classList.toggle("hidden", !attachment);
    dom.attachment.textContent = attachment
      ? `Reference: ${attachment.path}${attachment.selection ? " (selected text)" : ""} · click to remove` : "";
  }

  function render() {
    renderThreads();
    renderSelectors();
    renderMessages();
    renderApproval();
    renderWorkflowPrompt();
    renderAttachment();
    dom.notice.textContent = notice;
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "state") {
      state = message.state;
      capabilities = Array.isArray(message.capabilities) ? message.capabilities : [];
      modes = Array.isArray(message.state?.modes) && message.state.modes.length ? message.state.modes : modes;
      busy = message.busy === true;
      repositoryBusy = message.repositoryBusy === true;
      approval = message.approval || null;
      workflowPrompt = message.workflowPrompt || null;
      notice = message.notice || "";
      render();
    } else if (message.type === "attachment") {
      attachment = message.attachment || null;
      renderAttachment();
    } else if (message.type === "sent") {
      dom.prompt.value = "";
      attachment = null;
      renderAttachment();
    }
  });

  dom.provider.addEventListener("change", () => {
    renderSelectors();
    post({ type: "discover", provider: dom.provider.value });
  });
  dom.mode.addEventListener("change", () => {
    renderSelectors();
    if (dom.mode.value === "balanced") post({ type: "refresh" });
  });
  for (const provider of ["claude", "codex"]) {
    const name = provider === "claude" ? "Claude" : "Codex";
    dom[`balanced${name}Model`].addEventListener("change", (event) => {
      balancedSelection[`${provider}Model`] = event.target.value;
      balancedSelection[`${provider}Effort`] = "";
      renderBalancedSelectors();
    });
    dom[`balanced${name}Effort`].addEventListener("change", (event) => {
      balancedSelection[`${provider}Effort`] = event.target.value;
    });
  }
  dom.addMode.addEventListener("click", () => post({ type: "addMode" }));
  dom.deleteMode.addEventListener("click", () => post({ type: "deleteMode", id: dom.mode.value }));
  dom.model.addEventListener("change", () => { selectedModels[dom.provider.value] = dom.model.value; renderEfforts(); });
  dom.effort.addEventListener("change", () => { selectedEfforts[`${dom.provider.value}:${dom.model.value}`] = dom.effort.value; });
  dom.thread.addEventListener("change", () => post({ type: "selectThread", id: dom.thread.value }));
  dom.newThread.addEventListener("click", () => post({ type: "newThread" }));
  dom.deleteThread.addEventListener("click", () => post({ type: "deleteThread", id: dom.thread.value }));
  dom.renameThread.addEventListener("click", () => post({ type: "renameThread", id: dom.thread.value }));
  dom.exportThread.addEventListener("click", () => post({ type: "exportThread", id: dom.thread.value }));
  dom.search.addEventListener("input", renderThreads);
  dom.refresh.addEventListener("click", () => post({ type: "refresh" }));
  dom.addFile.addEventListener("click", () => post({ type: "addFile" }));
  dom.attachment.addEventListener("click", () => { attachment = null; renderAttachment(); });
  dom.stop.addEventListener("click", () => post({ type: "cancel" }));
  dom.send.addEventListener("click", () => {
    if (busy || !dom.prompt.value.trim()) return;
    const balanced = dom.mode.value === "balanced";
    post({ type: "send", text: dom.prompt.value, provider: dom.provider.value,
      model: dom.model.value, effort: dom.effort.value, mode: dom.mode.value, attachment,
      agents: balanced ? "real" : undefined,
      selection: balanced ? { ...balancedSelection } : undefined });
  });
  dom.prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); dom.send.click(); }
  });
  const decide = (decision) => { if (approval) post({ type: "approval", id: approval.id, decision }); };
  dom.approve.addEventListener("click", () => decide("accept"));
  dom.deny.addEventListener("click", () => decide("decline"));
  dom.cancelApproval.addEventListener("click", () => decide("cancel"));
  dom.workflowAnswer.addEventListener("input", renderWorkflowPrompt);
  dom.workflowSubmit.addEventListener("click", () => {
    if (!workflowPrompt) return;
    post({ type: "workflowResponse", id: workflowPrompt.id,
      decision: workflowPrompt.kind === "question" ? "answer" : "confirm", answer: dom.workflowAnswer.value });
  });
  dom.workflowCancel.addEventListener("click", () => {
    if (workflowPrompt) post({ type: "workflowResponse", id: workflowPrompt.id, decision: "cancel" });
  });
  post({ type: "ready" });
})();
