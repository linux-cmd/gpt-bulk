const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const assert = require("node:assert/strict");

function mock() {
  window.sent = [];
  const rollout = location.pathname.endsWith("-rollout");
  const toolbar = location.pathname.endsWith("-toolbar");
  const manual = location.pathname.endsWith("-manual");
  window.pastesWithoutFocus = 0;
  const editor = document.querySelector("#prompt-textarea");
  const send = document.querySelector("[data-testid=send-button]");
  const stop = document.querySelector("[data-testid=stop-button]");
  const messages = document.querySelector("main");
  if (manual) messages.querySelector("button").remove();
  function setRole(node, role, id) {
    if (toolbar) {
      const turn = role === "assistant" && node.parentElement?.matches("article") ? node.parentElement : node;
      turn.dataset.turn = role;
      turn.dataset.turnId = id;
    } else if (rollout) {
      node.dataset.chatgptSearchUnitKey = "unit:" + role;
      node.dataset.chatgptSearchMessageIds = id;
    } else {
      node.dataset.messageAuthorRole = role;
      node.dataset.messageId = id;
    }
  }
  if (rollout || toolbar) {
    for (const node of messages.querySelectorAll("[data-message-author-role]")) {
      setRole(node, node.dataset.messageAuthorRole, node.dataset.messageId);
      delete node.dataset.messageAuthorRole;
      delete node.dataset.messageId;
    }
    messages.querySelector("button").setAttribute("aria-label", rollout ? "Copy" : "Good response");
    if (toolbar) messages.querySelector("button").style.visibility = "hidden";
    editor.removeAttribute("id");
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-label", "Chat with ChatGPT");
    editor.closest("form").setAttribute("data-chatgpt-composer", "");
    send.removeAttribute("data-testid");
    send.setAttribute("aria-label", "Send");
    stop.removeAttribute("data-testid");
    stop.setAttribute("aria-label", "Stop");
  }
  editor.oninput = () => { send.disabled = !editor.innerText; };
  editor.onpaste = event => {
    event.preventDefault();
    if (document.activeElement !== editor) window.pastesWithoutFocus++;
    editor.innerHTML = event.clipboardData.getData("text/html");
    if (rollout) setTimeout(() => { send.disabled = false; }, 400);
    else send.disabled = false;
  };
  send.onclick = () => {
    const text = [...editor.children].map(paragraph => paragraph.textContent).join("\n");
    window.sent.push(text);
    if (window.ignoreSend) return;
    const user = document.createElement("div");
    setRole(user, "user", "u" + window.sent.length);
    user.style.whiteSpace = "pre-wrap";
    user.textContent = text;
    messages.append(user);
    editor.replaceChildren();
    send.disabled = true;
    stop.hidden = false;
  };
  window.think = () => {
    stop.hidden = true;
    const article = document.createElement("article");
    const answer = document.createElement("div");
    answer.textContent = "Checking sources…";
    article.append(answer);
    setRole(answer, "assistant", "a" + window.sent.length);
    if (rollout) answer.insertAdjacentHTML("beforeend", '<pre><button aria-label="Copy">Copy code</button></pre>');
    messages.append(article);
  };
  window.finish = () => {
    const button = document.createElement("button");
    button.setAttribute("aria-label", toolbar ? "Good response" : rollout ? "Copy" : "Copy response");
    if (toolbar) button.style.visibility = "hidden";
    button.textContent = "Copy";
    messages.lastElementChild.append(button);
  };
}
const html = [
  '<!doctype html><meta charset="utf-8">',
  '<main><div data-message-author-role="user" data-message-id="original">Hello</div>',
  '<article><div data-message-author-role="assistant" data-message-id="first">Hello!</div>',
  '<button aria-label="Copy response">Copy</button></article></main>',
  '<form><div id="prompt-textarea" contenteditable="true" style="white-space:pre-wrap"></div>',
  '<button type="button" data-testid="send-button" disabled>Send</button>',
  '<button type="button" data-testid="stop-button" hidden>Stop</button></form>',
  '<script>(' + mock.toString() + ')();</script>'
].join("");

async function main() {
  const profile = await mkdtemp(join(tmpdir(), "gpt-bulk-qa-"));
  const directory = resolve(__dirname, "..");
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: process.env.BROWSER_EXE ? undefined : "chromium",
      executablePath: process.env.BROWSER_EXE || undefined,
      headless: true,
      viewport: {width: 1280, height: 800},
      args: ["--disable-extensions-except=" + directory, "--load-extension=" + directory]
    });
    await context.route("https://chatgpt.com/c/*", route => route.fulfill({contentType: "text/html", body: html}));
    const tab = context.pages()[0];
    tab.setDefaultTimeout(10000);
    const rollout = Boolean(process.env.GPT_BULK_ROLLOUT);
    const toolbar = Boolean(process.env.GPT_BULK_TOOLBAR);
    const manual = Boolean(process.env.GPT_BULK_MANUAL);
    const target = "https://chatgpt.com/c/test-conversation" + (manual ? "-manual" : toolbar ? "-toolbar" : rollout ? "-rollout" : "");
    const editorSelector = rollout || toolbar ? '[aria-label="Chat with ChatGPT"]' : "#prompt-textarea";
    await tab.goto(target);
    await tab.getByText("GPT Bulk", {exact: true}).click();
    assert.equal(await tab.locator("[data-inline] + form").count(), 1);
    if (toolbar) {
      await tab.getByRole("button", {name: "Diagnostics"}).click();
      const report = JSON.parse(await tab.getByRole("textbox", {name: "GPT Bulk diagnostics"}).inputValue());
      assert.equal(report.replyActions, true);
      assert.equal(report.ready, true);
    }
    const add = async text => {
      const box = tab.getByRole("textbox", {name: "Prompt to queue"});
      await box.fill(text);
      await tab.getByRole("button", {name: "Add prompt"}).click();
      await box.evaluate(element => new Promise(resolve => {
        const interval = setInterval(() => {
          if (!element.value) { clearInterval(interval); resolve(); }
        }, 25);
      }));
    };
    const first = "Line one 🧪\n\nLine three: café";
    await add(first);
    await add("Second prompt");
    if (process.env.GPT_BULK_SCREENSHOT) {
      await tab.addStyleTag({content: "body{background:#101513;color:#edf2e9;font:18px system-ui;padding:60px}main{max-width:620px;margin:60px 0 30px}article,main>div{padding:18px;background:#253127;border-radius:12px;margin:12px 0}form{max-width:620px}#prompt-textarea{border:1px solid #52644f;border-radius:12px;min-height:55px;padding:12px}button{margin-top:8px}h1{font-size:52px;letter-spacing:-.05em;margin:0;color:#bef77a}"});
      await tab.evaluate(() => {
        const heading = document.createElement("h1");
        heading.textContent = "Queue prompts with GPT Bulk";
        const caption = document.createElement("p");
        caption.textContent = "Extension shown on a simulated conversation";
        document.body.prepend(heading, caption);
      });
      await tab.screenshot({path: process.env.GPT_BULK_SCREENSHOT});
      return;
    }
    const other = await context.newPage();
    other.setDefaultTimeout(10000);
    await other.goto(target);
    await other.bringToFront();
    if (rollout) {
      await tab.evaluate(selector => {
        const editor = document.querySelector(selector);
        editor.addEventListener("focus", () => editor.blur(), {once: true});
      }, editorSelector);
    }
    await tab.locator("button#start").evaluate(button => button.click());
    const confirm = tab.getByRole("button", {name: "I checked: ChatGPT finished"});
    if (manual) {
      await confirm.waitFor();
      await tab.waitForTimeout(1700);
      assert.deepEqual(await tab.evaluate(() => window.sent), []);
      await confirm.evaluate(button => button.click());
    }
    try {
      await tab.waitForFunction(() => window.sent.length === 1, null, {polling: 100});
    } catch (error) {
      console.error(await tab.locator("#status").textContent(), await tab.locator(editorSelector).evaluate(node => node.innerHTML));
      throw error;
    }
    assert.deepEqual(await tab.evaluate(() => window.sent), [first]);
    if (rollout) assert.equal(await tab.evaluate(() => window.pastesWithoutFocus), 1);
    await other.getByText("GPT Bulk", {exact: true}).click();
    await other.locator("button#start").evaluate(button => button.click());
    assert.deepEqual(await other.evaluate(() => window.sent), []);
    await tab.evaluate(() => window.think());
    await tab.waitForTimeout(2200);
    assert.deepEqual(await tab.evaluate(() => window.sent), [first]);
    if (manual) {
      await confirm.waitFor();
      await confirm.evaluate(button => button.click());
    } else await tab.evaluate(() => window.finish());
    await tab.waitForFunction(() => window.sent.length === 2, null, {polling: 100});
    await tab.evaluate(() => { window.think(); window.finish(); });
    await tab.getByText("Queue complete.", {exact: true}).waitFor();
    assert.deepEqual(await tab.evaluate(() => window.sent), [first, "Second prompt"]);
    assert.deepEqual(await other.evaluate(() => window.sent), []);
    await add("Third prompt");
    await tab.locator(editorSelector).fill("My existing draft");
    await tab.locator("button#start").click();
    await tab.getByText(/Clear or send the existing/).waitFor();
    assert.equal(await tab.locator(editorSelector).innerText(), "My existing draft");
    assert.equal(await tab.evaluate(() => window.sent.length), 2);
    await tab.locator(editorSelector).fill("");
    await tab.evaluate(() => { window.ignoreSend = true; });
    await tab.locator("button#start").click();
    try {
      await tab.waitForFunction(() => window.sent.length === 3, null, {polling: 100});
    } catch (error) {
      console.error(await tab.locator("#status").textContent(), await tab.locator(editorSelector).evaluate(node => node.innerHTML));
      throw error;
    }
    await tab.reload();
    await tab.getByText("GPT Bulk", {exact: true}).click();
    await tab.getByText(/resolving the interrupted send/).waitFor();
    assert.equal(await tab.locator("#start").isDisabled(), true);
    assert.equal(await tab.evaluate(() => window.sent.length), 0);
    console.log("Passed background-tab send, multiline integrity, thinking gap, duplicate guard, draft protection, and interrupted send recovery.");
  } finally {
    await context?.close();
    const root = resolve(tmpdir());
    if (resolve(profile).startsWith(join(root, "gpt-bulk-qa-"))) {
      await rm(profile, {recursive: true, force: true, maxRetries: 5});
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
