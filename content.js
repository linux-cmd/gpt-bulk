(() => {
  const api = globalThis.browser ?? chrome;
  const keyForPage = () => {
    const id = location.pathname.match(/\/c\/([\w-]+)\/?$/)?.[1];
    return id ? "gpt-bulk:" + id : null;
  };
  const find = (selector, root = document) => root.querySelector(selector);
  const visible = node => Boolean(node && !node.closest('[hidden], [aria-hidden="true"], [inert]') &&
    node.getClientRects().length && getComputedStyle(node).visibility === "visible");
  const shown = (selector, root = document) => [...root.querySelectorAll(selector)].filter(visible);
  const read = node => node.innerText.replace(/\r\n?/g, "\n");
  function readDraft(editor) {
    if (editor.childNodes.length === 1 && editor.firstChild.nodeName === "BR") return "";
    const lines = [];
    let inline = "";
    let hasInline = false;
    for (const node of editor.childNodes) {
      if (node.nodeName === "P" || node.nodeName === "DIV") {
        if (hasInline) lines.push(inline);
        lines.push([...node.childNodes].map((child, index, children) =>
          child.nodeName === "BR" ? (index === children.length - 1 ? "" : "\n") : child.textContent).join(""));
        inline = "";
        hasInline = false;
      } else {
        inline += node.nodeName === "BR" ? "\n" : node.textContent;
        hasInline = true;
      }
    }
    if (hasInline) lines.push(inline);
    return lines.join("\n");
  }
  const sendSelector = 'button[data-testid="send-button"], button[data-test-id="send-button"], button[data-testid="chat-input-send"], button[aria-label="Send"], button[aria-label="Send prompt"], button[aria-label="Send message"]';
  const stopSelector = '[data-testid="stop-button"], [data-test-id="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"], button[aria-label="Stop response"]';
  const composerSelector = 'form[data-chatgpt-composer], form[data-type="unified-composer"]';
  const editorSelector = '#prompt-textarea[contenteditable="true"], [contenteditable="true"][role="textbox"][aria-label="Chat with ChatGPT"], [contenteditable="true"][role="textbox"][aria-label="Message ChatGPT"], [contenteditable="true"][role="textbox"][aria-label="Ask ChatGPT"]';
  const turnSelector = '[data-testid^="conversation-turn-"], [data-test-id^="conversation-turn-"], article, [data-turn-key], [data-turn-id], [data-turn]';
  const messageSelector = '[data-message-author-role][data-message-id], [data-chatgpt-search-unit-key][data-chatgpt-search-message-ids], [data-turn][data-turn-id]';
  const replyActions = 'button[data-testid="copy-turn-action-button"], button[data-test-id="copy-turn-action-button"], button[data-testid="good-response-turn-action-button"], button[data-test-id="good-response-turn-action-button"], button[data-testid="bad-response-turn-action-button"], button[data-test-id="bad-response-turn-action-button"], button[aria-label="Copy response"], button[aria-label="Copy"], button[aria-label="Good response"], button[aria-label="Bad response"], button[aria-label="Read aloud"]';

  function turns() {
    const messages = new Map();
    for (const node of shown(messageSelector)) {
      const wrapper = node.matches('[data-turn][data-turn-id]') && !node.matches('[data-message-id], [data-chatgpt-search-message-ids]');
      if (wrapper && shown('[data-message-author-role][data-message-id], [data-chatgpt-search-unit-key][data-chatgpt-search-message-ids]', node).length) continue;
      const role = node.dataset.messageAuthorRole || node.dataset.chatgptSearchUnitKey?.split(":").at(-1) || node.dataset.turn;
      const id = node.dataset.messageId || node.dataset.chatgptSearchMessageIds?.trim().match(/^(?:\["|")?([\w:-]+)(?:"\]|")?$/)?.[1] || node.dataset.turnId;
      if ((role === "user" || role === "assistant") && id && !messages.has(id)) {
        messages.set(id, {id, role, node});
      }
    }
    return [...messages.values()];
  }

  function page() {
    const candidates = shown(editorSelector + ', :is(' + composerSelector + ') [contenteditable="true"]:is(.ProseMirror, [role="textbox"])');
    const editor = candidates.length === 1 ? candidates[0] : null;
    const form = editor?.closest(composerSelector) || editor?.closest("form");
    const sendButtons = form ? shown(sendSelector, form) : [];
    const send = sendButtons.length === 1 ? sendButtons[0] : null;
    const messages = turns();
    const user = messages.findLast(message => message.role === "user");
    const assistant = messages.at(-1);
    const turn = assistant?.role === "assistant" && assistant.node.closest(turnSelector);
    const finalActions = Boolean(turn && !messages.some(message => message !== assistant && turn.contains(message.node)) &&
      [...turn.querySelectorAll(replyActions)].some(button =>
      !button.closest('.markdown, [data-markdown-text-style], [data-markdown-copy], pre, code, [data-user-message-bubble]') &&
      (button.getAttribute("aria-label") !== "Copy" || turn === assistant.node || !assistant.node.contains(button)) &&
      button.getClientRects().length && !button.closest('[hidden], [inert]') &&
      !button.disabled && button.getAttribute("aria-disabled") !== "true"));
    const busy = shown(stopSelector + ', main [data-is-streaming="true"], main [data-streaming="true"]').length ||
      form?.getAttribute("aria-busy") === "true" || (turn && turn.getAttribute("aria-busy") === "true") ||
      (form && shown('button[aria-label="Stop"]', form).length);
    const problem = shown('[role="alert"], [role="dialog"], main button[aria-label="Continue generating"], main button[data-testid="continue-button"]').some(node =>
      /try again|continue generating|something went wrong|rate limit|usage limit|network error|sign in to continue/i.test(
        (node.getAttribute("aria-label") ?? "") + " " + node.textContent));
    const attachments = form && (shown('[data-testid*="attachment-preview"], [data-testid*="file-preview"], button[aria-label^="Remove file"], button[aria-label^="Remove attachment"]', form).length ||
      [...form.querySelectorAll('input[type="file"]')].some(node => node.files?.length));
    return {
      editor, send, user: user?.node, userId: user?.id, assistantId: turn && assistant.id,
      replyText: finalActions ? assistant.node.textContent : "",
      done: Boolean(editor && form && user && finalActions && !busy && !problem),
      finalActions, turnCount: messages.length,
      waitingFor: !editor || !form ? "the ChatGPT message composer" :
        !user || !turn ? "the latest ChatGPT reply" : "the latest reply’s completion controls",
      busy, problem, attachments
    };
  }

  const host = document.createElement("div");
  const panel = host.attachShadow({mode: "open"});
  panel.innerHTML = `
    <style>
      :host{all:initial;position:fixed;right:16px;bottom:40px;z-index:2147483647;color-scheme:light dark;font:14px system-ui}
      .queue-panel{width:min(350px,calc(100vw - 32px));background:Canvas;color:CanvasText;border:1px solid GrayText;border-radius:14px;box-shadow:0 8px 30px #0003}
      .queue-panel:not([open]){width:max-content} summary{cursor:pointer;padding:12px 16px;font-weight:700}
      section{padding:0 12px 12px} textarea{box-sizing:border-box;width:100%;min-height:90px;resize:vertical;border-radius:8px;padding:8px}
      button{font:inherit;cursor:pointer;border-radius:7px;padding:5px 9px;margin:3px 3px 3px 0}
      ol{padding-left:22px;max-height:190px;overflow:auto} li{white-space:pre-wrap;overflow-wrap:anywhere} p{margin:8px 0}
    </style>
    <details class="queue-panel"><summary>GPT Bulk</summary><section>
      <p id="status" role="status"></p>
      <textarea aria-label="Prompt to queue" placeholder="Write or paste a prompt"></textarea>
      <div><button id="add">Add prompt</button><button id="start">Start</button><button id="pause">Pause</button></div>
      <div id="resolve" hidden><button id="sent">Remove sent prompt</button><button id="retry">Keep for retry</button></div>
      <ol></ol>
      <details><summary>Troubleshooting</summary><button id="diagnostics">Show diagnostics</button>
      <textarea id="report" aria-label="GPT Bulk diagnostics" readonly hidden></textarea></details>
    </section></details>`;
  document.body.append(host);
  const ui = id => panel.getElementById(id);
  const input = find("textarea", panel);
  const list = find("ol", panel);
  const instance = crypto.randomUUID();
  let key, record, status, run, timer, serial = Promise.resolve();

  const load = async id => (await api.storage.local.get(id))[id] ?? {queue: [], flight: null};
  const save = (id, state) => api.storage.local.set({[id]: state});
  const lock = (id, fn) => navigator.locks.request(id, fn);

  function render() {
    ui("status").textContent = status;
    ui("add").disabled = !record;
    ui("start").disabled = Boolean(run || !record?.queue.length || (record.flight && record.flight.owner !== instance));
    ui("pause").disabled = !run;
    ui("resolve").hidden = Boolean(run || !record?.flight);
    list.replaceChildren();
    for (const item of record?.queue ?? []) {
      const row = document.createElement("li");
      row.textContent = item.text;
      const remove = document.createElement("button");
      remove.textContent = "Remove";
      remove.disabled = item.id === record.flight?.id;
      remove.onclick = () => edit(state => {
        if (state.flight?.id !== item.id) state.queue = state.queue.filter(entry => entry.id !== item.id);
      });
      row.append(" ", remove);
      list.append(row);
    }
  }

  function pause(message) {
    const active = run;
    run = null;
    active?.release?.();
    status = message;
    render();
  }

  function serially(task) {
    serial = serial.then(task).catch(error => {
      console.warn("GPT Bulk", error);
      pause("Queue paused. Browser storage or page access failed.");
    });
  }

  function schedule(delay = 0) {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      serially(tick);
    }, delay);
  }

  async function sync() {
    const next = keyForPage();
    if (next === key) return;
    key = next;
    record = null;
    pause(next ? "Loading queue…" : "Send the first message in ChatGPT, then queue follow-ups here.");
    if (!next) return;
    record = await load(next);
    status = record.flight ? "Check the chat before resolving the interrupted send." : "Queue paused.";
    render();
  }

  function edit(change, after) {
    const id = key;
    serially(async () => {
      if (!id || id !== keyForPage()) return;
      await lock(id, async () => {
        const state = await load(id);
        if (id !== keyForPage()) return;
        change(state);
        await save(id, state);
        record = state;
        after?.();
      });
      render();
      schedule();
    });
  }

  function settled(active, snapshot) {
    const identity = JSON.stringify([snapshot.userId, snapshot.assistantId, snapshot.replyText]);
    if (active.identity !== identity) {
      active.identity = identity;
      active.since = performance.now();
    }
    return performance.now() - active.since >= 1500;
  }

  function putDraft(editor, text) {
    editor.focus({preventScroll: true});
    // Direct the editing event at ChatGPT's editor even if the browser kept
    // keyboard focus on the queue panel or in another tab.
    if (document.activeElement === editor) {
      const caret = document.createRange();
      caret.selectNodeContents(editor);
      caret.collapse(false);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(caret);
    }
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    const clipboard = document.createElement("div");
    for (const line of text.split("\n")) {
      const paragraph = document.createElement("p");
      if (line) paragraph.textContent = line;
      else paragraph.append(document.createElement("br"));
      clipboard.append(paragraph);
    }
    clipboardData.setData("text/html", clipboard.innerHTML);
    const unhandled = editor.dispatchEvent(new ClipboardEvent("paste", {
      clipboardData, bubbles: true, cancelable: true, composed: true
    }));
    if (unhandled && readDraft(editor) === "" && document.activeElement === editor) {
      document.execCommand("insertText", false, text);
    }
  }

  async function advance(active, id, stillActive) {
    const state = await load(id);
    if (!stillActive()) return;
    record = state;
    const snapshot = page();
    const flight = state.flight;
    if (snapshot.problem) return pause("ChatGPT needs attention. Check the conversation before resuming.");
    if (flight) {
      if (flight.owner !== instance) return pause("Resolve the previous send before continuing.");
      if (!flight.userId && snapshot.userId && snapshot.userId !== flight.previousUserId) {
        const message = find('[data-testid="collapsible-user-message-content"], [data-user-message-bubble], .whitespace-pre-wrap', snapshot.user) ?? snapshot.user;
        if (read(message) !== flight.text) return pause("The latest message differs from the queued prompt. Check the chat.");
        flight.userId = snapshot.userId;
        active.lastBusy = Date.now();
        await save(id, state);
      }
      if (!stillActive()) return;
      if (flight.userId && snapshot.userId !== flight.userId) return pause("The conversation changed while waiting for ChatGPT.");
      if (!flight.userId && Date.now() - flight.started > 45000) return pause("Could not confirm the send. Check whether the prompt appeared.");
      status = flight.userId ? "Waiting for ChatGPT to finish…" : "Confirming the send…";
      if (!flight.userId || !snapshot.done) {
        active.identity = null;
        if (snapshot.busy) active.lastBusy = Date.now();
        else if (flight.userId && Date.now() - active.lastBusy > 45000) {
          pause("Could not verify that ChatGPT finished the reply. Check the chat before continuing.");
        }
        return;
      }
      if (!settled(active, snapshot)) return;
      state.queue = state.queue.filter(item => item.id !== flight.id);
      state.flight = null;
      await save(id, state);
      return;
    }
    if (!state.queue.length) return pause("Queue complete.");
    if (!snapshot.done) {
      active.identity = null;
      status = snapshot.busy ? "Waiting for ChatGPT to finish…" : "Waiting for " + snapshot.waitingFor + "…";
      if (snapshot.busy) active.lastBusy = Date.now();
      else if (Date.now() - active.lastBusy > 45000) pause("Could not find " + snapshot.waitingFor + ". Refresh ChatGPT and resume.");
      return;
    }
    if (!settled(active, snapshot)) return;
    if (readDraft(snapshot.editor) !== "" || snapshot.attachments) return pause("Clear or send the existing ChatGPT draft before resuming.");
    const item = state.queue[0];
    state.flight = {id: item.id, text: item.text, owner: instance, previousUserId: snapshot.userId, started: Date.now()};
    await save(id, state);
    const ready = candidate => stillActive() && candidate.done && candidate.userId === snapshot.userId &&
      candidate.assistantId === snapshot.assistantId && !candidate.attachments;
    const before = page();
    let issue = "ChatGPT changed before the draft could be prepared.";
    if (ready(before) && readDraft(before.editor) === "") {
      status = "Preparing the next prompt…";
      render();
      putDraft(before.editor, item.text);
      const deadline = performance.now() + 3000;
      do {
        const after = page();
        if (!ready(after) || after.editor !== before.editor) break;
        const draft = readDraft(after.editor);
        if (draft !== item.text) {
          issue = draft === "" ? "ChatGPT did not accept the draft." : "The ChatGPT draft differs from the queued prompt.";
        } else if (after.send && !after.send.disabled && after.send.getAttribute("aria-disabled") !== "true") {
          active.identity = null;
          status = "Confirming the send…";
          after.send.click();
          return;
        } else {
          issue = "The draft is ready, but ChatGPT’s Send button did not become available.";
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (performance.now() < deadline);
    }
    state.flight = null;
    await save(id, state);
    if (stillActive()) pause(issue + " Review the ChatGPT composer before restarting.");
  }

  async function tick() {
    await sync();
    const active = run;
    if (!active?.release) return;
    const id = key;
    const stillActive = () => run === active && keyForPage() === id;
    await lock(id, () => advance(active, id, stillActive));
    render();
    if (run) schedule(350);
  }

  ui("start").addEventListener("mousedown", event => {
    if (event.button === 0) event.preventDefault();
  });
  ui("start").onclick = () => {
    if (run || !record?.queue.length || key !== keyForPage()) return;
    const active = {lastBusy: Date.now()};
    const id = key;
    run = active;
    status = "Checking ChatGPT…";
    render();
    navigator.locks.request(id + ":runner", {ifAvailable: true}, held => {
      if (run !== active) return;
      if (!held) return pause("The queue is running in another tab for this conversation.");
      return new Promise(resolve => {
        active.release = resolve;
        schedule();
      });
    }).catch(() => { if (run === active) pause("This browser could not start the queue safely."); });
  };
  ui("pause").onclick = () => pause("Queue paused. Any reply already underway can finish.");
  ui("add").onclick = () => {
    const text = input.value;
    if (!text.trim()) return;
    edit(state => { state.queue.push({id: crypto.randomUUID(), text}); }, () => {
      if (input.value === text) input.value = "";
    });
  };
  input.onkeydown = event => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      ui("add").click();
    }
  };
  function resolveSend(sent) {
    const id = key;
    const item = record?.flight?.id;
    if (!item || run) return;
    navigator.locks.request(id + ":runner", {ifAvailable: true}, held => {
      if (!held) return pause("The queue is active in another tab.");
      return new Promise(resolve => {
        serially(async () => {
          try {
            await lock(id, async () => {
              if (keyForPage() !== id) return;
              const state = await load(id);
              if (state.flight?.id !== item) return;
              if (sent) state.queue = state.queue.filter(entry => entry.id !== item);
              state.flight = null;
              await save(id, state);
              record = state;
              pause("Queue paused. Review the conversation before restarting.");
            });
          } finally {
            resolve();
          }
        });
      });
    }).catch(() => pause("Could not resolve the previous send."));
  }
  ui("sent").onclick = () => resolveSend(true);
  ui("retry").onclick = () => resolveSend(false);
  ui("diagnostics").onclick = () => {
    const snapshot = page();
    const report = ui("report");
    report.hidden = false;
    report.value = JSON.stringify({
      version: api.runtime.getManifest().version,
      composer: Boolean(snapshot.editor), send: Boolean(snapshot.send),
      turns: snapshot.turnCount, userTurn: Boolean(snapshot.userId), replyTurn: Boolean(snapshot.assistantId),
      replyActions: snapshot.finalActions, busy: Boolean(snapshot.busy), ready: snapshot.done,
      queued: record?.queue.length ?? 0
    }, null, 2);
    report.select();
  };
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[key]) return;
    serially(async () => {
      if (key !== keyForPage()) return;
      record = await load(key);
      render();
    });
  });
  new MutationObserver(() => {
    if ((run || key !== keyForPage()) && timer === undefined) schedule();
  }).observe(document.body, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["aria-label", "aria-busy", "disabled", "data-is-streaming", "data-streaming"]
  });
  window.addEventListener("popstate", () => schedule());
  window.addEventListener("pageshow", () => schedule());
  window.addEventListener("pagehide", () => pause("Queue paused."));
  document.addEventListener("visibilitychange", () => schedule());
  document.addEventListener("click", event => {
    if (run && event.target instanceof Element &&
        event.target.closest(stopSelector + ', :is(' + composerSelector + ') button[aria-label="Stop"]')) {
      pause("ChatGPT was stopped. Review the reply before resuming.");
    }
  }, true);
  if (navigator.locks) schedule();
  else pause("This browser does not support the locking needed for safe sends.");
})();
