(() => {
  const api = globalThis.browser ?? chrome;
  const keyForPage = () => {
    const id = location.pathname.match(/\/c\/([\w-]+)\/?$/)?.[1];
    return id ? "gpt-bulk:" + id : null;
  };
  const find = (selector, root = document) => root.querySelector(selector);
  const visible = node => Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility === "visible");
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
  const sendSelector = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]';
  const stopSelector = '[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"], button[aria-label="Stop response"]';

  function page() {
    const editor = find('#prompt-textarea[contenteditable="true"]');
    const form = editor?.closest("form");
    const send = form && shown(sendSelector, form)[0];
    const control = send || (form && shown('[data-testid="composer-speech-button"], [data-testid="voice-mode-button"], button[aria-label="Start voice mode"], button[aria-label="Use voice mode"]', form)[0]);
    const messages = [...document.querySelectorAll('main [data-message-author-role="user"], main [data-message-author-role="assistant"]')];
    const user = messages.findLast(node => node.dataset.messageAuthorRole === "user");
    const assistant = messages.at(-1);
    const turn = assistant?.dataset.messageAuthorRole === "assistant" &&
      assistant.closest('[data-testid^="conversation-turn-"], article');
    const finalActions = turn && shown('button[data-testid="copy-turn-action-button"], button[aria-label="Copy response"]', turn).length;
    const busy = shown(stopSelector + ', main [data-is-streaming="true"], main [data-streaming="true"], main [aria-busy="true"]').length;
    const problem = shown('[role="alert"], [role="dialog"], main button[aria-label="Continue generating"], main button[data-testid="continue-button"]').some(node =>
      /try again|continue generating|something went wrong|rate limit|usage limit|network error|sign in to continue/i.test(
        (node.getAttribute("aria-label") ?? "") + " " + node.textContent));
    const attachments = form && (shown('[data-testid*="attachment-preview"], [data-testid*="file-preview"], button[aria-label^="Remove file"], button[aria-label^="Remove attachment"]', form).length ||
      [...form.querySelectorAll('input[type="file"]')].some(node => node.files?.length));
    return {
      editor, send, user, userId: user?.dataset.messageId, assistantId: turn && assistant.dataset.messageId,
      done: Boolean(visible(editor) && control && user?.dataset.messageId && finalActions && assistant.dataset.messageId && !busy && !problem),
      busy, problem, attachments
    };
  }

  const host = document.createElement("div");
  const panel = host.attachShadow({mode: "open"});
  panel.innerHTML = `
    <style>
      :host{all:initial;position:fixed;right:16px;bottom:40px;z-index:2147483647;color-scheme:light dark;font:14px system-ui}
      details{width:min(350px,calc(100vw - 32px));background:Canvas;color:CanvasText;border:1px solid GrayText;border-radius:14px;box-shadow:0 8px 30px #0003}
      details:not([open]){width:max-content} summary{cursor:pointer;padding:12px 16px;font-weight:700}
      section{padding:0 12px 12px} textarea{box-sizing:border-box;width:100%;min-height:90px;resize:vertical;border-radius:8px;padding:8px}
      button{font:inherit;cursor:pointer;border-radius:7px;padding:5px 9px;margin:3px 3px 3px 0}
      ol{padding-left:22px;max-height:190px;overflow:auto} li{white-space:pre-wrap;overflow-wrap:anywhere} p{margin:8px 0}
    </style>
    <details><summary>GPT Bulk</summary><section>
      <p id="status" role="status"></p>
      <textarea aria-label="Prompt to queue" placeholder="Write or paste a prompt"></textarea>
      <div><button id="add">Add prompt</button><button id="start">Start</button><button id="pause">Pause</button></div>
      <div id="resolve" hidden><button id="sent">Remove sent prompt</button><button id="retry">Keep for retry</button></div>
      <ol></ol>
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
    const identity = snapshot.userId + ":" + snapshot.assistantId;
    if (active.identity !== identity) {
      active.identity = identity;
      active.since = performance.now();
    }
    return performance.now() - active.since >= 1500;
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
        const message = find(".whitespace-pre-wrap", snapshot.user) ?? snapshot.user;
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
      status = "Waiting for a finished reply…";
      if (snapshot.busy) active.lastBusy = Date.now();
      else if (Date.now() - active.lastBusy > 45000) pause("Could not confirm a finished reply. Check ChatGPT and resume.");
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
    if (ready(before) && readDraft(before.editor) === "") {
      before.editor.focus({preventScroll: true});
      if (document.activeElement === before.editor) {
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/plain", item.text);
        const clipboard = document.createElement("div");
        for (const line of item.text.split("\n")) {
          const paragraph = document.createElement("p");
          if (line) paragraph.textContent = line;
          else paragraph.append(document.createElement("br"));
          clipboard.append(paragraph);
        }
        clipboardData.setData("text/html", clipboard.innerHTML);
        before.editor.dispatchEvent(new ClipboardEvent("paste", {clipboardData, bubbles: true, cancelable: true}));
        if (readDraft(before.editor) === "") document.execCommand("insertText", false, item.text);
      }
      const after = page();
      if (ready(after) && after.editor === before.editor && readDraft(after.editor) === item.text &&
          after.send && !after.send.disabled && after.send.getAttribute("aria-disabled") !== "true") {
        active.identity = null;
        status = "Confirming the send…";
        after.send.click();
        return;
      }
    }
    state.flight = null;
    await save(id, state);
    if (stillActive()) pause("Could not verify the full draft and Send button. Review the ChatGPT composer.");
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
    if (run && event.target instanceof Element && event.target.closest(stopSelector)) {
      pause("ChatGPT was stopped. Review the reply before resuming.");
    }
  }, true);
  if (navigator.locks) schedule();
  else pause("This browser does not support the locking needed for safe sends.");
})();
