const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const assert = require("node:assert/strict");

function mock() {
  window.sent = [];
  const editor = document.querySelector("#prompt-textarea");
  const send = document.querySelector("[data-testid=send-button]");
  const stop = document.querySelector("[data-testid=stop-button]");
  const messages = document.querySelector("main");
  editor.oninput = () => { send.disabled = !editor.innerText; };
  editor.onpaste = event => {
    event.preventDefault();
    editor.innerHTML = event.clipboardData.getData("text/html");
    send.disabled = false;
  };
  send.onclick = () => {
    const text = [...editor.children].map(paragraph => paragraph.textContent).join("\n");
    window.sent.push(text);
    if (window.ignoreSend) return;
    const user = document.createElement("div");
    user.dataset.messageAuthorRole = "user";
    user.dataset.messageId = "u" + window.sent.length;
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
    answer.dataset.messageAuthorRole = "assistant";
    answer.dataset.messageId = "a" + window.sent.length;
    answer.textContent = "Checking sources…";
    article.append(answer);
    messages.append(article);
  };
  window.finish = () => {
    const button = document.createElement("button");
    button.setAttribute("aria-label", "Copy response");
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
    const target = "https://chatgpt.com/c/test-conversation";
    await tab.goto(target);
    await tab.getByText("GPT Bulk", {exact: true}).click();
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
    await tab.locator("button#start").evaluate(button => button.click());
    try {
      await tab.waitForFunction(() => window.sent.length === 1, null, {polling: 100});
    } catch (error) {
      console.error(await tab.locator("#status").textContent(), await tab.locator("#prompt-textarea").evaluate(node => node.innerHTML));
      throw error;
    }
    assert.deepEqual(await tab.evaluate(() => window.sent), [first]);
    await other.getByText("GPT Bulk", {exact: true}).click();
    await other.locator("button#start").evaluate(button => button.click());
    assert.deepEqual(await other.evaluate(() => window.sent), []);
    await tab.evaluate(() => window.think());
    await tab.waitForTimeout(2200);
    assert.deepEqual(await tab.evaluate(() => window.sent), [first]);
    await tab.evaluate(() => window.finish());
    await tab.waitForFunction(() => window.sent.length === 2, null, {polling: 100});
    await tab.evaluate(() => { window.think(); window.finish(); });
    await tab.getByText("Queue complete.", {exact: true}).waitFor();
    assert.deepEqual(await tab.evaluate(() => window.sent), [first, "Second prompt"]);
    assert.deepEqual(await other.evaluate(() => window.sent), []);
    await add("Third prompt");
    await tab.locator("#prompt-textarea").fill("My existing draft");
    await tab.locator("button#start").click();
    await tab.getByText(/Clear or send the existing/).waitFor();
    assert.equal(await tab.locator("#prompt-textarea").innerText(), "My existing draft");
    assert.equal(await tab.evaluate(() => window.sent.length), 2);
    await tab.locator("#prompt-textarea").fill("");
    await tab.evaluate(() => { window.ignoreSend = true; });
    await tab.locator("button#start").click();
    try {
      await tab.waitForFunction(() => window.sent.length === 3, null, {polling: 100});
    } catch (error) {
      console.error(await tab.locator("#status").textContent(), await tab.locator("#prompt-textarea").evaluate(node => node.innerHTML));
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
