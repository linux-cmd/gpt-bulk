(() => {
  const api = globalThis.browser ?? chrome;
  const lifecycle = new AbortController();
  const keyForPage = () => {
    const id = location.pathname.match(/\/c\/([\w-]+)\/?$/)?.[1];
    return id ? "gpt-bulk:" + id : null;
  };
  const find = (selector, root = document) => root.querySelector(selector);
  const visible = node => Boolean(node && !node.closest('[hidden], [aria-hidden="true"], [inert]') &&
    node.getClientRects().length && getComputedStyle(node).visibility === "visible");
  const shown = (selector, root = document) => [...root.querySelectorAll(selector)].filter(visible);
  const read = node => node.innerText.replace(/\r\n?/g, "\n");
  function readInline(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
    if (node.nodeName === "BR") return node.matches(".ProseMirror-trailingBreak") ? "" : "\n";
    return [...node.childNodes].map(readInline).join("");
  }
  function readDraft(editor) {
    if (editor.childNodes.length === 1 && editor.firstChild.nodeName === "BR") return "";
    const lines = [];
    let inline = "";
    let hasInline = false;
    for (const node of editor.childNodes) {
      if (node.nodeName === "P" || node.nodeName === "DIV") {
        if (hasInline) lines.push(inline);
        const placeholder = node.childNodes.length === 1 && node.firstChild.nodeName === "BR";
        lines.push(placeholder ? "" : readInline(node));
        inline = "";
        hasInline = false;
      } else {
        inline += readInline(node);
        hasInline = true;
      }
    }
    if (hasInline) lines.push(inline);
    return lines.join("\n");
  }
  const sendSelector = 'button[data-testid="send-button"], button[data-test-id="send-button"], button[data-testid="chat-input-send"], button[aria-label="Send"], button[aria-label="Send prompt"], button[aria-label="Send message"], button#composer-submit-button[type="submit"]';
  const stopSelector = '[data-testid="stop-button"], [data-test-id="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"], button[aria-label="Stop response"]';
  const hasStop = form => Boolean(shown(stopSelector).length || (form && shown('button[aria-label="Stop"]', form).length));
  const idleSelector = 'button[data-testid="composer-speech-button"], button[data-testid="voice-mode-button"], button[aria-label="Start voice mode"], button[aria-label="Use voice mode"]';
  const composerSelector = 'form[data-chatgpt-composer], form[data-type="unified-composer"]';
  const editorSelector = '#prompt-textarea[contenteditable="true"], [contenteditable="true"][role="textbox"][aria-label="Chat with ChatGPT"], [contenteditable="true"][role="textbox"][aria-label="Message ChatGPT"], [contenteditable="true"][role="textbox"][aria-label="Ask ChatGPT"]';
  const turnSelector = '[data-testid^="conversation-turn-"], [data-test-id^="conversation-turn-"], article, [data-turn-key], [data-turn-id], [data-turn]';
  const messageBodySelector = '[data-message-author-role], [data-chatgpt-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":assistant"]';
  const turnWrapperSelector = '[data-turn="user"], [data-turn="assistant"]';
  const messageSelector = messageBodySelector + ", " + turnWrapperSelector;
  const nodeIds = new WeakMap();
  const replyActions = 'button[data-testid="copy-turn-action-button"], button[data-test-id="copy-turn-action-button"], button[data-testid="good-response-turn-action-button"], button[data-test-id="good-response-turn-action-button"], button[data-testid="bad-response-turn-action-button"], button[data-test-id="bad-response-turn-action-button"], button[aria-label="Copy response"], button[aria-label="Copy"], button[aria-label="Good response"], button[aria-label="Bad response"], button[aria-label="Read aloud"]';

  function turns() {
    const messages = new Map();
    for (const node of shown(messageSelector)) {
      const wrapper = node.matches(turnWrapperSelector) && !node.matches(messageBodySelector);
      if (wrapper && shown(messageBodySelector, node).length) continue;
      const role = node.dataset.messageAuthorRole || node.dataset.chatgptSearchUnitKey?.split(":").at(-1) || node.dataset.turn;
      if (role !== "user" && role !== "assistant") continue;
      const scope = node.closest(turnWrapperSelector) ?? node;
      let id = node.dataset.messageId || node.dataset.chatgptSearchMessageIds?.trim().match(/^(?:\["|")?([\w:-]+)(?:"\]|")?$/)?.[1] ||
        scope.dataset.turnId || nodeIds.get(scope);
      if (!id) {
        id = "local:" + crypto.randomUUID();
        nodeIds.set(scope, id);
      }
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
    const sendButtons = form ? shown(sendSelector, form).filter(button =>
      !button.matches(stopSelector) && !/stop|voice|dictat/i.test(button.getAttribute("aria-label") ?? "")) : [];
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
    const stop = hasStop(form);
    const busy = stop || shown('main [data-is-streaming="true"], main [data-streaming="true"]').length ||
      form?.getAttribute("aria-busy") === "true" || (turn && turn.getAttribute("aria-busy") === "true") ||
      (turn && shown('[data-is-streaming="true"], [data-streaming="true"], [aria-label="Thinking"], [aria-label="Working"]', turn).length);
    const idle = Boolean(form && (shown(idleSelector, form).some(button =>
      !button.disabled && button.getAttribute("aria-disabled") !== "true") ||
      (send && !send.disabled && send.getAttribute("aria-disabled") !== "true")));
    const problem = shown('[role="alert"], [role="dialog"], main button[aria-label="Continue generating"], main button[data-testid="continue-button"]').some(node =>
      /try again|continue generating|something went wrong|rate limit|usage limit|network error|sign in to continue/i.test(
        (node.getAttribute("aria-label") ?? "") + " " + node.textContent));
    const attachments = form && (shown('[data-testid*="attachment-preview"], [data-testid*="file-preview"], button[aria-label^="Remove file"], button[aria-label^="Remove attachment"]', form).length ||
      [...form.querySelectorAll('input[type="file"]')].some(node => node.files?.length));
    return {
      editor, form, send, user: user?.node, userId: user?.id, assistantId: turn && assistant.id,
      replyText: turn ? assistant.node.textContent : "",
      done: Boolean(editor && form && user && finalActions && !busy && !problem),
      finalActions, turnCount: messages.length,
      waitingFor: !editor || !form ? "the ChatGPT message composer" :
        !user || !turn ? "the latest ChatGPT reply" : "the latest reply’s completion controls",
      stop, busy, idle, problem, attachments
    };
  }

  const host = document.createElement("div");
  const panel = host.attachShadow({mode: "open"});
  panel.innerHTML = `
    <style>
      :host{all:initial;position:fixed;right:16px;bottom:40px;z-index:2147483647;color-scheme:light dark;font:14px/1.5 system-ui;color:CanvasText}
      :host([data-inline]){position:relative;inset:auto;z-index:auto;display:block;width:100%;min-width:0;margin:0 0 8px}
      .queue-panel{width:min(410px,calc(100vw - 32px));box-sizing:border-box;background:Canvas;border:1px solid color-mix(in srgb, CanvasText 22%, Canvas);border-radius:16px;box-shadow:0 8px 24px #0002}
      :host([data-inline]) .queue-panel{width:100%;box-shadow:none}
      .queue-panel:not([open]){width:max-content} summary{cursor:pointer;padding:9px 14px;font-weight:700}
      #count{font-weight:500;opacity:.75;margin-left:8px} section{padding:0 12px 12px}
      textarea{font:inherit;box-sizing:border-box;width:100%;min-height:62px;resize:vertical;border:1px solid color-mix(in srgb, CanvasText 26%, Canvas);border-radius:10px;padding:8px;background:Canvas;color:CanvasText}
      button{font:inherit;font-weight:600;cursor:pointer;border:1px solid color-mix(in srgb, CanvasText 24%, Canvas);border-radius:999px;padding:5px 11px;background:Canvas;color:CanvasText}
      button:disabled{opacity:.45;cursor:default} button:focus-visible,summary:focus-visible,textarea:focus-visible{outline:2px solid #538ce7;outline-offset:2px}
      #start{background:CanvasText;color:Canvas} #confirm{margin:7px 0} #diagnostics{margin-left:auto}
      .actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:6px 0} ol{margin:8px 0 0;padding-left:24px;max-height:108px;overflow:auto}
      li{white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0} li button{padding:2px 8px;margin-left:8px;font-size:12px}
      p{margin:4px 0 8px} [hidden]{display:none!important}
    </style>
    <details class="queue-panel"><summary><span>GPT Bulk</span><span id="count"></span></summary><section>
      <p id="status" role="status"></p>
      <textarea aria-label="Prompt to queue" placeholder="Write or paste a prompt"></textarea>
      <div class="actions"><button id="add">Add prompt</button><button id="start">Start</button><button id="pause">Pause</button><button id="diagnostics">Diagnostics</button></div>
      <button id="confirm" hidden>I checked: ChatGPT finished</button>
      <div id="resolve" hidden><button id="sent">Remove sent prompt</button><button id="retry">Keep for retry</button></div>
      <ol></ol>
      <textarea id="report" aria-label="GPT Bulk diagnostics" readonly hidden></textarea>
    </section></details>`;
  document.body.append(host);
  const ui = id => panel.getElementById(id);
  const input = find("textarea", panel);
  const list = find("ol", panel);
  const instance = crypto.randomUUID();
  let key, record, status, run, timer, observer, renderedQueue, serial = Promise.resolve();

  function contextReady(error) {
    if (lifecycle.signal.aborted) return false;
    try {
      if (api.runtime?.id && !/extension context invalidated/i.test(String(error ?? ""))) return true;
    } catch {
      // Accessing the old runtime can throw after an extension reload.
    }
    lifecycle.abort();
    observer?.disconnect();
    clearTimeout(timer);
    const active = run;
    run = null;
    active?.release?.();
    const section = panel.querySelector("section");
    const notice = document.createElement("p");
    notice.textContent = "GPT Bulk was reloaded. Refresh this ChatGPT tab to reconnect.";
    notice.setAttribute("role", "status");
    const refresh = document.createElement("button");
    refresh.textContent = "Refresh ChatGPT";
    refresh.onclick = () => location.reload();
    section.replaceChildren(notice, refresh);
    panel.querySelector("details").open = true;
    return false;
  }

  panel.addEventListener("click", event => {
    if (!contextReady()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, {capture: true, signal: lifecycle.signal});

  function mount() {
    const editor = shown(editorSelector + ', :is(' + composerSelector + ') [contenteditable="true"]:is(.ProseMirror, [role="textbox"])');
    const form = editor.length === 1 && (editor[0].closest(composerSelector) || editor[0].closest("form"));
    if (form?.parentElement && host.nextElementSibling !== form) form.before(host);
    if (!form && host.parentElement !== document.body) document.body.append(host);
    host.toggleAttribute("data-inline", Boolean(form));
  }

  const load = async id => (await api.storage.local.get(id))[id] ?? {queue: [], flight: null};
  const save = (id, state) => api.storage.local.set({[id]: state});
  const lock = (id, fn) => navigator.locks.request(id, fn);

  function render() {
    if (!contextReady()) return;
    ui("status").textContent = status;
    ui("count").textContent = record?.queue.length ? record.queue.length + " queued" : "";
    ui("add").disabled = !record;
    ui("start").disabled = Boolean(run || !record?.queue.length || (record.flight && record.flight.owner !== instance));
    ui("pause").disabled = !run;
    ui("resolve").hidden = Boolean(run || !record?.flight);
    ui("confirm").hidden = !run?.canConfirm;
    const queueState = JSON.stringify([record?.flight?.id, (record?.queue ?? []).map(item => item.id)]);
    if (queueState === renderedQueue) return;
    renderedQueue = queueState;
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
    serial = serial.then(() => {
      if (contextReady()) return task();
    }).catch(error => {
      if (!contextReady(error)) return;
      console.warn("GPT Bulk", error);
      pause("Queue paused. Browser storage or page access failed.");
    });
    return serial;
  }

  function schedule(delay = 0) {
    if (!contextReady()) return;
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

  const identityOf = snapshot => JSON.stringify([snapshot.userId, snapshot.assistantId, snapshot.replyText]);
  function settled(active, snapshot) {
    const identity = identityOf(snapshot);
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
    const paragraph = document.createElement("p");
    paragraph.style.whiteSpace = "pre-wrap";
    // Encode line breaks inside one paragraph. Separate paragraphs can be
    // serialized with extra blank lines by the ChatGPT composer.
    for (const [index, line] of text.split("\n").entries()) {
      if (index) paragraph.append(document.createElement("br"));
      if (line) paragraph.append(document.createTextNode(line));
    }
    clipboardData.setData("text/html", paragraph.outerHTML);
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
    active.canConfirm = false;
    if (snapshot.problem) return pause("ChatGPT needs attention. Check the conversation before resuming.");
    if (snapshot.busy) {
      active.confirmed = null;
      active.completedByControls = null;
    }
    const canProceed = candidate => candidate.done || Boolean(
      candidate.editor && candidate.form && !candidate.busy && !candidate.problem &&
      (active.confirmed === identityOf(candidate) ||
        (candidate.idle && active.completedByControls === identityOf(candidate))));
    const offerConfirmation = () => {
      active.canConfirm = Boolean(snapshot.editor && snapshot.form && !snapshot.busy);
      if (active.canConfirm) status = "ChatGPT’s finish signal is unavailable. If the reply is complete, confirm below.";
    };
    if (flight) {
      if (flight.owner !== instance) return pause("Resolve the previous send before continuing.");
      if (active.observedFlight !== flight.id) {
        active.observedFlight = flight.id;
        active.sawStop = false;
        active.idleCandidate = null;
      }
      if (snapshot.stop) active.sawStop = true;
      if (!flight.userId && snapshot.userId && snapshot.userId !== flight.previousUserId) {
        const message = find('[data-testid="collapsible-user-message-content"], [data-user-message-bubble], .whitespace-pre-wrap', snapshot.user) ?? snapshot.user;
        if (read(message) !== flight.text && readDraft(message) !== flight.text) {
          return pause("The latest message differs from the queued prompt. Check the chat.");
        }
        flight.userId = snapshot.userId;
        active.lastBusy = Date.now();
        await save(id, state);
      }
      if (!stillActive()) return;
      if (flight.userId && snapshot.userId !== flight.userId) return pause("The conversation changed while waiting for ChatGPT.");
      if (!flight.userId && Date.now() - flight.started > 45000) return pause("Could not confirm the send. Check whether the prompt appeared.");
      status = flight.userId ? "Waiting for ChatGPT to finish…" : "Confirming the send…";
      // Some layouts omit the reply toolbar. Require an observed Stop control,
      // a fresh reply for the verified prompt, and a sustained return to idle.
      if (flight.userId && active.sawStop && snapshot.assistantId &&
          snapshot.assistantId !== flight.previousAssistantId && snapshot.replyText.trim() &&
          snapshot.idle && !snapshot.busy) {
        const identity = identityOf(snapshot);
        if (active.idleCandidate?.identity !== identity) active.idleCandidate = {identity, since: performance.now()};
        if (performance.now() - active.idleCandidate.since >= 8000) active.completedByControls = identity;
        else if (!snapshot.done) {
          status = "ChatGPT looks idle. Verifying the reply before sending the next prompt…";
          active.identity = null;
          return;
        }
      } else {
        active.idleCandidate = null;
      }
      if (!flight.userId || !canProceed(snapshot)) {
        active.identity = null;
        if (snapshot.busy) active.lastBusy = Date.now();
        else if (flight.userId) offerConfirmation();
        return;
      }
      if (!settled(active, snapshot)) return;
      state.queue = state.queue.filter(item => item.id !== flight.id);
      state.flight = null;
      await save(id, state);
      return;
    }
    if (!state.queue.length) return pause("Queue complete.");
    if (!canProceed(snapshot)) {
      active.identity = null;
      status = snapshot.busy ? "Waiting for ChatGPT to finish…" : "Waiting for " + snapshot.waitingFor + "…";
      if (snapshot.busy) active.lastBusy = Date.now();
      else if (snapshot.editor && snapshot.form) offerConfirmation();
      else if (Date.now() - active.lastBusy > 45000) pause("Could not find " + snapshot.waitingFor + ". Refresh ChatGPT and resume.");
      return;
    }
    if (!settled(active, snapshot)) return;
    if (readDraft(snapshot.editor) !== "" || snapshot.attachments) return pause("Clear or send the existing ChatGPT draft before resuming.");
    const item = state.queue[0];
    state.flight = {id: item.id, text: item.text, owner: instance, previousUserId: snapshot.userId,
      previousAssistantId: snapshot.assistantId, started: Date.now()};
    await save(id, state);
    const ready = candidate => stillActive() && !candidate.busy && !candidate.problem &&
      (canProceed(candidate) || active.completedByControls === identityOf(candidate)) && candidate.userId === snapshot.userId &&
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
          active.confirmed = null;
          active.completedByControls = null;
          active.observedFlight = item.id;
          active.sawStop = false;
          active.idleCandidate = null;
          active.watchedForm = after.form;
          status = "Confirming the send…";
          after.send.click();
          if (hasStop(after.form)) active.sawStop = true;
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
    mount();
    await sync();
    const active = run;
    if (!active?.release) return;
    const id = key;
    const stillActive = () => contextReady() && run === active && keyForPage() === id;
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
  ui("confirm").onclick = () => {
    if (!run?.canConfirm || key !== keyForPage()) return;
    const snapshot = page();
    if (!snapshot.editor || !snapshot.form || snapshot.busy || snapshot.problem) return schedule();
    run.confirmed = identityOf(snapshot);
    run.canConfirm = false;
    status = "Reply confirmed. Checking the composer…";
    render();
    schedule();
  };
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
      return serially(async () => {
        await lock(id, async () => {
          if (!contextReady() || keyForPage() !== id) return;
          const state = await load(id);
          if (state.flight?.id !== item) return;
          if (sent) state.queue = state.queue.filter(entry => entry.id !== item);
          state.flight = null;
          await save(id, state);
          record = state;
          if (contextReady()) pause("Queue paused. Review the conversation before restarting.");
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
      replyActions: snapshot.finalActions, busy: Boolean(snapshot.busy), idleControl: snapshot.idle,
      observedStop: Boolean(run?.sawStop), ready: snapshot.done,
      sentPromptConfirmed: Boolean(record?.flight?.userId), checkingIdle: Boolean(run?.idleCandidate),
      status,
      queued: record?.queue.length ?? 0
    }, null, 2);
    report.focus();
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
  observer = new MutationObserver(() => {
    if (run?.watchedForm && run.observedFlight === record?.flight?.id && key === keyForPage() &&
        !run.sawStop && hasStop(run.watchedForm)) {
      run.sawStop = true;
    }
    if (timer === undefined && (run || key !== keyForPage() || !host.isConnected || !host.nextElementSibling?.matches("form"))) {
      schedule(100);
    }
  });
  observer.observe(document.body, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["aria-label", "aria-busy", "disabled", "hidden", "data-testid", "data-test-id", "data-is-streaming", "data-streaming"]
  });
  const options = {signal: lifecycle.signal};
  window.addEventListener("popstate", () => schedule(), options);
  window.addEventListener("pageshow", () => schedule(), options);
  window.addEventListener("pagehide", () => { if (contextReady()) pause("Queue paused."); }, options);
  document.addEventListener("visibilitychange", () => schedule(), options);
  document.addEventListener("click", event => {
    if (run && event.target instanceof Element &&
        event.target.closest(stopSelector + ', :is(' + composerSelector + ') button[aria-label="Stop"]')) {
      pause("ChatGPT was stopped. Review the reply before resuming.");
    }
  }, {...options, capture: true});
  if (navigator.locks) schedule();
  else pause("This browser does not support the locking needed for safe sends.");
})();
