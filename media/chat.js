(() => {
  "use strict";
  const api = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);
  const dom = Object.fromEntries([
    "thread", "new-thread", "rename-thread", "export-thread", "delete-thread", "search", "search-row", "search-toggle",
    "account", "refresh", "repo-lock", "settings", "settings-scrim", "settings-close", "settings-toggle", "settings-perm",
    "claude-account", "claude-email", "claude-usage", "add-claude-account", "login-claude-account", "remove-claude-account",
    "codex-account", "codex-email", "codex-usage", "add-codex-account", "login-codex-account", "remove-codex-account",
    "balanced-claude-model", "balanced-claude-effort", "balanced-codex-model", "balanced-codex-effort", "execution-permission",
    "settings-digest", "selection-notice", "notice", "messages", "empty", "approval", "approval-summary", "approval-detail", "approve", "deny", "cancel-approval",
    "workflow-prompt", "workflow-title", "workflow-detail", "workflow-answer-label", "workflow-answer", "workflow-submit", "workflow-cancel",
    "workflow-secondary", "strict-controls", "strict-permission", "strict-hint",
    "mode",
    "attachment", "prompt", "stop", "send", "send-label",
  ].map((id) => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), el(id)]));
  let state = null;
  let stateSession = "";
  let chatRevision = -1;
  let renderedChatKey = "";
  let renderedThreadsKey = "";
  let capabilities = [];
  let accountChoices = { profiles: [], selected: { claude: "default", codex: "default" } };
  let busy = false;
  let repositoryBusy = false;
  let approval = null;
  let workflowPrompt = null;
  let workflowPromptId = "";
  let attachment = null;
  let notice = "";
  let settingsOpen = false;
  let searchOpen = false;
  let liveTask = null;
  let preferencesLoaded = false;
  let settingsEdited = false;
  const savedUi = api.getState?.() || null;
  const balancedSelection = { claudeModel: "", claudeEffort: "", codexModel: "", codexEffort: "" };

  function turnSettings() {
    return { mode: dom.mode.value === "strict" ? "strict" : "balanced",
      executionPermission: dom.executionPermission.value === "fullAccess" ? "fullAccess" : "askBeforeChange",
      selection: { ...balancedSelection } };
  }
  function persistUi() {
    api.setState?.({ turnSettings: turnSettings(), draft: dom.prompt.value,
      settingsOpen, searchOpen });
  }
  function persistTurnSettings() {
    preferencesLoaded = true;
    settingsEdited = true;
    persistUi();
    post({ type: "turnSettings", settings: turnSettings() });
  }
  function applyTurnSettings(raw) {
    if (!raw || typeof raw !== "object") return;
    dom.mode.value = raw.mode === "strict" ? "strict" : "balanced";
    dom.executionPermission.value = raw.executionPermission === "fullAccess" ? "fullAccess" : "askBeforeChange";
    for (const key of Object.keys(balancedSelection)) {
      const value = raw.selection?.[key];
      balancedSelection[key] = typeof value === "string" && value.length <= 100 && !/\s/.test(value) ? value : "";
    }
  }

  const post = (message) => api.postMessage(message);
  const option = (value, label) => {
    const node = document.createElement("option");
    node.value = value;
    node.textContent = label;
    return node;
  };
  const setOptions = (control, entries) => {
    if (control.options.length !== entries.length || entries.some((entry, index) =>
      control.options[index].value !== entry.value || control.options[index].textContent !== entry.label)) {
      control.replaceChildren(...entries.map((entry) => option(entry.value, entry.label)));
    }
  };
  const node = (tag, className, text) => {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
  };
  const providerLabel = (provider) => provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : provider;
  const capabilityFor = (provider) => capabilities.find((entry) => entry.provider === provider);
  const emailFor = (provider, id) => accountChoices.emails?.[provider]?.[id] ||
    (accountChoices.selected?.[provider] === id ? capabilityFor(provider)?.accountEmail : "") || "";
  const emailDescription = (provider, id) => emailFor(provider, id) ||
    (accountChoices.emails?.[provider] && Object.hasOwn(accountChoices.emails[provider], id)
      ? "email unavailable" : "checking email");
  function usageNodes(usage) {
    if (!usage) return [node("span", "", "Usage unavailable from this CLI")];
    const checked = new Date(usage.checkedAt);
    const when = Number.isNaN(checked.getTime()) ? "" : ` · checked ${checked.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    const rows = [node("span", "usage-heading", `Plan usage${when}`)];
    if (usage.access === "blocked") rows.push(node("span", "usage-blocked", "Codex reports included usage blocked"));
    if (!Array.isArray(usage.windows) || !usage.windows.length) rows.push(node("span", "", "No quota windows reported"));
    for (const window of (usage.windows || []).slice(0, 12)) {
      const reset = new Date(window.resetsAt);
      const resets = window.resetsAt && !Number.isNaN(reset.getTime())
        ? ` · resets ${reset.toLocaleString([], { dateStyle: "short", timeStyle: "short" })}` : "";
      rows.push(node("span", "", `${window.label}: ${window.usedPercent}% used${resets}`));
    }
    return rows;
  }
  function renderAccounts() {
    for (const provider of ["claude", "codex"]) {
      const name = providerLabel(provider);
      const control = dom[`${provider}Account`];
      const profiles = accountChoices.profiles.filter((entry) => entry.provider === provider);
      const email = emailFor(provider, accountChoices.selected[provider] || "default");
      dom[`${provider}Email`].textContent = email ? `Signed in as ${email}` : "Email unavailable · sign in or refresh";
      dom[`${provider}Email`].title = email || "The selected CLI login has not supplied an email.";
      dom[`${provider}Usage`].replaceChildren(...usageNodes(capabilityFor(provider)?.usage));
      const selected = accountChoices.selected[provider] || "default";
      const withIdentity = (id, label) => `${label} · ${emailDescription(provider, id)}`;
      const entries = [{ id: "default", label: withIdentity("default", "Current CLI login") },
        ...profiles.map((entry) => ({ id: entry.id, label: withIdentity(entry.id, entry.label) }))];
      if (document.activeElement !== control && (control.options.length !== entries.length || entries.some((entry, index) =>
        control.options[index].value !== entry.id || control.options[index].textContent !== entry.label))) {
        control.replaceChildren(...entries.map((entry) => option(entry.id, entry.label)));
      }
      if (document.activeElement !== control) control.value = selected;
      control.disabled = busy;
      dom[`add${name}Account`].disabled = busy;
      dom[`login${name}Account`].disabled = busy;
      dom[`remove${name}Account`].disabled = busy || control.value === "default";
    }
  }
  function renderSelectors() {
    renderBalancedSelectors();
    dom.account.textContent = `Claude + Codex · ${["claude", "codex"].map((name) => {
      const info = capabilityFor(name);
      const identity = info?.accountEmail || "email unavailable";
      return `${providerLabel(name)}: ${identity}${info?.reason ? ` (${info.reason})` : ""}`;
    }).join(" · ")}`;
    renderLiveStatus();
    dom.send.disabled = busy || repositoryBusy;
    dom.settingsToggle.disabled = busy;
    if (busy && settingsOpen) setSettingsOpen(false);
    renderModeControls();
    dom.stop.classList.toggle("hidden", !busy);
    renderSettingsDigest();
  }

  function renderLiveStatus() {
    const elapsed = liveTask && Number.isFinite(liveTask.since)
      ? Math.max(0, Math.floor((Date.now() - liveTask.since) / 1000)) : 0;
    const age = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
    dom.repoLock.textContent = busy ? `${liveTask?.label || "Task starting"} · ${age} since last update`
      : repositoryBusy ? "Repository busy: task running elsewhere" : "";
    dom.repoLock.setAttribute?.("title", busy
      ? `${liveTask?.label || "Task starting"}. Last state update ${age} ago. The provider may be working silently.`
      : repositoryBusy
        ? "Repository busy: another Countersign task is active in this VS Code window."
        : "One Countersign task at a time per repository in this VS Code window.");
    dom.repoLock.classList.toggle("busy", busy || repositoryBusy);
  }

  /** Keeps the composer button honest about what the next turn will use. */
  function renderSettingsDigest() {
    const label = (control) => (control.value && control.options?.[control.selectedIndex]?.textContent) || control.value;
    const agent = (name, modelControl, effortControl) => {
      const model = label(modelControl);
      if (!model) return `${name} default`;
      const effort = label(effortControl);
      return effort ? `${model} · ${effort}` : model;
    };
    const claude = agent("Claude", dom.balancedClaudeModel, dom.balancedClaudeEffort);
    const codex = agent("Codex", dom.balancedCodexModel, dom.balancedCodexEffort);
    const chosen = dom.balancedClaudeModel.value || dom.balancedCodexModel.value;
    const claudeEmail = emailFor("claude", dom.claudeAccount.value) || "email unavailable";
    const codexEmail = emailFor("codex", dom.codexAccount.value) || "email unavailable";
    const mode = dom.mode.value === "strict" ? "Strict" : "Balanced";
    const digest = `${claudeEmail} / ${codexEmail} · ${mode} · ${chosen ? `${claude} / ${codex}` : "Default models"}`;
    const fullAccess = dom.executionPermission.value === "fullAccess";
    const permission = fullAccess ? "Full access" : "Ask";
    dom.settingsDigest.textContent = digest;
    dom.settingsPerm.textContent = permission;
    dom.settingsPerm.classList.toggle("warn", fullAccess);
    dom.settingsToggle.setAttribute?.("title", `Turn settings — ${digest}, ${permission} after plan approval`);
  }

  function setSettingsOpen(open) {
    settingsOpen = open;
    dom.settings.classList.toggle("hidden", !open);
    dom.settingsScrim.classList.toggle("hidden", !open);
    dom.settingsToggle.classList.toggle("active", open);
    dom.settingsToggle.setAttribute?.("aria-expanded", String(open));
    persistUi();
  }

  function setSearchOpen(open) {
    searchOpen = open;
    dom.searchRow.classList.toggle("hidden", !open);
    dom.searchToggle.classList.toggle("active", open);
    if (!open && dom.search.value) { dom.search.value = ""; renderThreads(); }
    if (open) dom.search.focus?.();
    persistUi();
  }

  function renderBalancedSelectors() {
    const unavailable = [];
    for (const provider of ["claude", "codex"]) {
      const name = provider === "claude" ? "Claude" : "Codex";
      const modelKey = `${provider}Model`;
      const effortKey = `${provider}Effort`;
      const modelControl = dom[`balanced${name}Model`];
      const effortControl = dom[`balanced${name}Effort`];
      const models = (capabilities.find((entry) => entry.provider === provider)?.models ?? [])
        .filter((entry) => entry.value !== "default");
      setOptions(modelControl, [{ value: "", label: "Default (CLI)" },
        ...models.map((entry) => ({ value: entry.value, label: entry.label })),
        ...(balancedSelection[modelKey] && !models.some((entry) => entry.value === balancedSelection[modelKey])
          ? [{ value: balancedSelection[modelKey], label: `Saved: ${balancedSelection[modelKey]} (unavailable)` }] : [])]);
      modelControl.value = balancedSelection[modelKey];
      if (models.length && balancedSelection[modelKey] &&
          !models.some((entry) => entry.value === balancedSelection[modelKey])) {
        unavailable.push(`${name} model “${balancedSelection[modelKey]}” is not in this catalogue; the saved choice remains visible. A task started now will use the CLI default for it.`);
      }
      modelControl.disabled = busy;
      const selected = models.find((entry) => entry.value === modelControl.value);
      // Exactly the levels this model's catalogue reports, with its own labels.
      const levels = selected?.effortLevels ?? [];
      if (selected && balancedSelection[effortKey] &&
          !levels.some((level) => level.value === balancedSelection[effortKey])) {
        unavailable.push(`${name} effort “${balancedSelection[effortKey]}” is not offered for this model; the saved choice was replaced with the CLI default.`);
        balancedSelection[effortKey] = "";
      }
      setOptions(effortControl, [{ value: "", label: "Default (CLI)" },
        ...levels.map((level) => ({ value: level.value, label: level.label || level.value }))]);
      effortControl.value = balancedSelection[effortKey];
      effortControl.disabled = !selected || busy;
    }
    dom.selectionNotice.textContent = unavailable.join(" ");
    dom.selectionNotice.classList.toggle("hidden", unavailable.length === 0);
  }

  function renderThreads() {
    const current = state?.activeThreadId;
    const query = dom.search.value.trim().toLowerCase();
    const key = `${stateSession}:${chatRevision}:${query}`;
    if (key !== renderedThreadsKey) {
      const threads = (state?.threads ?? []).filter((thread) => !query || thread.title.toLowerCase().includes(query) ||
        thread.messages.some((message) => message.text.toLowerCase().includes(query)));
      dom.thread.replaceChildren(...threads.map((thread) => option(thread.id, thread.title)));
      if (current) dom.thread.value = current;
      renderedThreadsKey = key;
    }
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
    const key = `${stateSession}:${chatRevision}`;
    if (renderedChatKey === key) return;
    const thread = state?.threads.find((entry) => entry.id === state.activeThreadId);
    const nearBottom = dom.messages.scrollHeight - dom.messages.scrollTop - dom.messages.clientHeight < 70;
    const messages = thread?.messages ?? [];
    dom.empty.classList.toggle("hidden", messages.length > 0);
    dom.messages.replaceChildren(...messages.map(messageNode));
    if (nearBottom) dom.messages.scrollTop = dom.messages.scrollHeight;
    renderedChatKey = key;
  }

  function renderApproval() {
    dom.approval.classList.toggle("hidden", !approval);
    dom.approvalSummary.textContent = approval?.summary || "";
    dom.approvalDetail.textContent = approval?.detail || "";
  }

  function renderWorkflowPrompt() {
    dom.workflowPrompt.classList.toggle("hidden", !workflowPrompt);
    if (!workflowPrompt) { workflowPromptId = ""; return; }
    const strict = workflowPrompt.strict || null;
    if (workflowPrompt.id !== workflowPromptId) {
      dom.workflowAnswer.value = "";
      workflowPromptId = workflowPrompt.id;
      if (strict) dom.strictPermission.value = strict.executionPermission;
    }
    dom.workflowTitle.textContent = workflowPrompt.title;
    dom.workflowDetail.textContent = workflowPrompt.detail;
    const question = workflowPrompt.kind === "question";
    const paused = workflowPrompt.kind === "pause";
    dom.workflowAnswerLabel.classList.toggle("hidden", !question);
    dom.strictControls.classList.toggle("hidden", !strict);
    if (strict) {
      // The estimate is shown, never enforced.
      dom.strictHint.textContent = strict.expectedFilesComplete
        ? `Plan ${strict.planHash.slice(0, 12)}… expects ${strict.expectedFileCount} file(s).`
        : `Plan ${strict.planHash.slice(0, 12)}… cannot estimate how many files it will touch.`;
    }
    dom.workflowSubmit.textContent = question ? "Send answer" : paused ? "Resume task" : "Approve plan";
    dom.workflowSubmit.disabled = question && !dom.workflowAnswer.value.trim();
    const secondary = paused ? "Stop task" : strict ? "Refuse plan" : "";
    dom.workflowSecondary.textContent = secondary;
    dom.workflowSecondary.classList.toggle("hidden", !secondary);
  }

  function renderModeControls() {
    dom.sendLabel.textContent = dom.mode.value === "strict" ? "Start Strict task" : "Start workflow";
  }

  function renderAttachment() {
    dom.attachment.classList.toggle("hidden", !attachment);
    dom.attachment.textContent = attachment
      ? `Reference: ${attachment.path}${attachment.selection ? " (selected text)" : ""} · click to remove` : "";
  }

  function render() {
    renderThreads();
    renderAccounts();
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
      if (!preferencesLoaded && typeof savedUi?.draft === "string") {
        dom.prompt.value = savedUi.draft.slice(0, 100_000);
      }
      if (!preferencesLoaded || !settingsEdited) {
        // Workspace state is authoritative after a reload. The webview memento can be
        // older and must never write its copy back over a newer workspace value.
        if (message.turnSettingsStored) applyTurnSettings(message.turnSettings);
        else if (!preferencesLoaded && savedUi?.turnSettings) {
          applyTurnSettings(savedUi.turnSettings);
          post({ type: "turnSettings", settings: turnSettings() });
        }
        preferencesLoaded = true;
        persistUi();
      }
      state = message.state;
      stateSession = typeof message.sessionId === "string" ? message.sessionId : "";
      chatRevision = Number.isInteger(message.chatRevision) ? message.chatRevision : chatRevision + 1;
      capabilities = Array.isArray(message.capabilities) ? message.capabilities : [];
      accountChoices = message.accounts || accountChoices;
      busy = message.busy === true;
      repositoryBusy = message.repositoryBusy === true;
      liveTask = message.liveTask || null;
      approval = message.approval || null;
      workflowPrompt = message.workflowPrompt || null;
      notice = message.notice || "";
      try { render(); }
      catch (error) {
        dom.notice.textContent = `The sidebar could not render this update. Reopen the view or press Refresh. ${String(error).slice(0, 160)}`;
        post({ type: "uiError", detail: String(error).slice(0, 200) });
      }
    } else if (message.type === "attachment") {
      attachment = message.attachment || null;
      renderAttachment();
    } else if (message.type === "sent") {
      dom.prompt.value = "";
      attachment = null;
      renderAttachment();
      persistUi();
    }
  });

  for (const provider of ["claude", "codex"]) {
    const name = provider === "claude" ? "Claude" : "Codex";
    dom[`${provider}Account`].addEventListener("change", (event) => {
      post({ type: "selectAccount", provider, id: event.target.value });
    });
    dom[`${provider}Account`].addEventListener("blur", renderAccounts);
    dom[`add${name}Account`].addEventListener("click", () => post({ type: "addAccount", provider }));
    dom[`login${name}Account`].addEventListener("click", () => post({ type: "loginAccount", provider }));
    dom[`remove${name}Account`].addEventListener("click", () => post({ type: "removeAccount", provider }));
    dom[`balanced${name}Model`].addEventListener("change", (event) => {
      balancedSelection[`${provider}Model`] = event.target.value;
      // The level is not wiped here: the catalogue of the new model decides whether it
      // survives, and dropping it silently is exactly what the notice exists to prevent.
      renderBalancedSelectors();
      renderSettingsDigest();
      persistTurnSettings();
    });
    dom[`balanced${name}Effort`].addEventListener("change", (event) => {
      balancedSelection[`${provider}Effort`] = event.target.value;
      renderSettingsDigest();
      persistTurnSettings();
    });
  }
  dom.executionPermission.addEventListener("change", () => { renderSettingsDigest(); persistTurnSettings(); });
  dom.settingsToggle.addEventListener("click", () => setSettingsOpen(!settingsOpen));
  dom.settingsClose.addEventListener("click", () => setSettingsOpen(false));
  dom.settingsScrim.addEventListener("click", () => setSettingsOpen(false));
  dom.searchToggle.addEventListener("click", () => setSearchOpen(!searchOpen));
  document.addEventListener?.("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (settingsOpen) setSettingsOpen(false);
    else if (searchOpen) setSearchOpen(false);
  });
  dom.thread.addEventListener("change", () => post({ type: "selectThread", id: dom.thread.value }));
  dom.newThread.addEventListener("click", () => post({ type: "newThread" }));
  dom.deleteThread.addEventListener("click", () => post({ type: "deleteThread", id: dom.thread.value }));
  dom.renameThread.addEventListener("click", () => post({ type: "renameThread", id: dom.thread.value }));
  dom.exportThread.addEventListener("click", () => post({ type: "exportThread", id: dom.thread.value }));
  dom.search.addEventListener("input", renderThreads);
  dom.refresh.addEventListener("click", () => post({ type: "refresh" }));
  dom.attachment.addEventListener("click", () => { attachment = null; renderAttachment(); });
  dom.stop.addEventListener("click", () => post({ type: "cancel" }));
  dom.send.addEventListener("click", () => {
    if (busy || !dom.prompt.value.trim()) return;
    setSettingsOpen(false);
    const mode = dom.mode.value === "strict" ? "strict" : "balanced";
    post({ type: "send", text: dom.prompt.value, attachment,
      mode: dom.mode.value === "strict" ? "strict" : "balanced",
      accounts: { claude: dom.claudeAccount.value, codex: dom.codexAccount.value },
      selection: { ...balancedSelection },
      executionPermission: dom.executionPermission.value });
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
    if (workflowPrompt.kind === "strictPlan") {
      post({ type: "workflowResponse", id: workflowPrompt.id, decision: "approve",
        executionPermission: dom.strictPermission.value });
      return;
    }
    if (workflowPrompt.kind === "pause") {
      post({ type: "workflowResponse", id: workflowPrompt.id, decision: "resume" });
      return;
    }
    post({ type: "workflowResponse", id: workflowPrompt.id,
      decision: workflowPrompt.kind === "question" ? "answer" : "confirm", answer: dom.workflowAnswer.value });
  });
  dom.workflowSecondary.addEventListener("click", () => {
    if (!workflowPrompt) return;
    if (workflowPrompt.kind === "pause") post({ type: "workflowResponse", id: workflowPrompt.id, decision: "stop" });
    else if (workflowPrompt.kind === "strictPlan") post({ type: "workflowResponse", id: workflowPrompt.id, decision: "refuse" });
  });
  dom.mode.addEventListener("change", () => { renderModeControls(); renderSettingsDigest(); persistTurnSettings(); });
  dom.prompt.addEventListener("input", persistUi);
  dom.workflowCancel.addEventListener("click", () => {
    if (workflowPrompt) post({ type: "workflowResponse", id: workflowPrompt.id, decision: "cancel" });
  });
  if (savedUi?.turnSettings) {
    applyTurnSettings(savedUi.turnSettings);
    if (typeof savedUi.draft === "string") dom.prompt.value = savedUi.draft.slice(0, 100_000);
    if (savedUi.settingsOpen) setSettingsOpen(true);
    if (savedUi.searchOpen) setSearchOpen(true);
  }
  document.addEventListener?.("visibilitychange", () => {
    if (!document.hidden) post({ type: "ready" });
    else persistUi();
  });
  post({ type: "ready" });
  post({ type: "refresh" });
  setInterval(() => { if (busy) renderLiveStatus(); }, 1_000);
})();
