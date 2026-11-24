# GPT Bulk

Queue text prompts in a ChatGPT conversation and let them run in order while you work in another tab.

[Product website and download](https://gptbulk-extension.vercel.app) · [Privacy policy](https://gptbulk-extension.vercel.app/privacy)

## Install

| Browser | Extensions page |
| --- | --- |
| Chrome | chrome://extensions |
| Edge | edge://extensions |
| Brave | brave://extensions |
| Opera | opera:extensions |
| Vivaldi and other compatible desktop Chromium browsers | Open the browser’s extension manager |

Turn on **Developer mode**, choose **Load unpacked**, and select **C:\Users\abhij\Extra\GPT Bulk**. Refresh any open ChatGPT tabs.

For a temporary Firefox installation, open **about:debugging**, choose **This Firefox**, click **Load Temporary Add-on**, and select **manifest.json**. Firefox removes temporary installations when it restarts. Safari and mobile browsers are outside this package’s supported scope.

## Use the queue

1. Open an existing conversation on **chatgpt.com**. In a new chat, send the first message manually to create the conversation.
2. Open **GPT Bulk** in the lower right. Type or paste one prompt at a time and select **Add prompt**. Ctrl+Enter or Cmd+Enter also adds the prompt.
3. Select **Start**. Keep the conversation tab open. You can switch tabs while the queue runs.
4. If GPT Bulk pauses after an uncertain send, check the conversation. Use **Remove sent prompt** if the prompt appeared or **Keep for retry** if it did not. Check for leftover draft text before restarting.

Queues are stored locally by conversation. A reload or closed tab pauses processing. Chrome can suspend background tabs and a sleeping computer pauses execution. Prompts go through the ChatGPT website using your existing session and its usage limits. The extension uses no API key or external server.

## How sending works

GPT Bulk requires an idle composer and the latest assistant turn’s completion controls. Both must stay present for a short interval. Before clicking Send, it checks the conversation, reads back the whole draft, and verifies that the Send button is enabled. It waits for the matching new user message and that message’s completed assistant reply before moving on. It records a send attempt before clicking so it can ask you to resolve an interrupted send instead of replaying it automatically.

ChatGPT can change these controls. If the extension cannot recognize a completion or verify the prompt, it waits or pauses. It supports the English ChatGPT interface and text prompts with no attachments.

## Browser check

Install Playwright separately, run its Chromium installer, and run **node qa/browser.cjs**. Set **PLAYWRIGHT_MODULE** if Playwright is installed outside this folder. Set **BROWSER_EXE** to try an installed Chromium browser in a fresh profile. The check uses a simulated ChatGPT page. It exercises a thinking gap, exact multiline text, duplicate runner protection, draft protection, and an interrupted send without sending live prompts.
