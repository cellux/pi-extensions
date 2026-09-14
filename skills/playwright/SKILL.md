---
name: playwright
description: Use the globally installed Playwright in the sandbox container for browser automation, web inspection, screenshots, PDFs, and UI verification. Load when a task requires interacting with or testing a web page.
---

# Playwright in the sandbox

Use the Playwright installation already provided by the sandbox. Do **not** add Playwright to the project or run `npm install` unless the user explicitly asks for a project-local dependency.

## Installation

The following are available globally:

- CLI: `/usr/local/bin/playwright`
- Node package: `/usr/local/lib/node_modules/playwright`
- Version: check with `playwright --version`
- Browser binaries: `/ms-playwright`
- `PLAYWRIGHT_BROWSERS_PATH` is configured to use `/ms-playwright`

Verify the installation when needed:

```bash
command -v playwright
playwright --version
playwright install --list
```

The image normally includes Chromium and Firefox (including their required system libraries). Do not download browsers again unless verification shows that one is missing. If a browser is missing, `playwright install chromium` or `playwright install firefox` may be used; avoid `--with-deps` as the sandbox user cannot install system packages.

## Preferred usage

For simple, one-shot tasks, use the global CLI directly—not `npx`:

```bash
playwright screenshot --full-page https://example.com /tmp/example.png
playwright pdf --paper-format A4 https://example.com /tmp/example.pdf
playwright open https://example.com
playwright codegen https://example.com
```

Use a headless workflow in the container. There is normally no graphical display, so do not rely on headed browser windows or interactive GUI output. Save artifacts under `/tmp` or an appropriate project directory and inspect them with the available tools.

Useful CLI options include:

```bash
playwright screenshot --wait-for-selector 'main' URL /tmp/page.png
playwright screenshot --viewport-size '1280,720' URL /tmp/page.png
playwright screenshot --browser firefox URL /tmp/page.png
playwright screenshot --save-storage /tmp/auth.json URL /tmp/page.png
playwright screenshot --load-storage /tmp/auth.json URL /tmp/page.png
```

Use `playwright --help` and `<command> --help` for the current command syntax.

## Programmatic browser scripts

When a task needs assertions, multiple actions, DOM inspection, network handling, or custom logic, create a temporary `.mjs` script and import the global package by its absolute path. A project-local `import { chromium } from 'playwright'` will not resolve unless the project has its own dependency.

```bash
cat >/tmp/check-page.mjs <<'EOF'
import { chromium } from '/usr/local/lib/node_modules/playwright/index.mjs';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
console.log('title:', await page.title());
console.log('heading:', await page.getByRole('heading').first().textContent());
await page.screenshot({ path: '/tmp/example.png', fullPage: true });
await browser.close();
EOF
node /tmp/check-page.mjs
```

Use resilient, user-facing locators in scripts, in roughly this order:

```js
page.getByRole('button', { name: 'Submit' })
page.getByLabel('Email')
page.getByPlaceholder('Search')
page.getByText('Continue')
page.locator('[data-testid="result"]')
```

Prefer Playwright's auto-waiting and web-first assertions over arbitrary sleeps. Use `page.waitForTimeout()` only when there is a specific reason, and prefer waiting for a selector, URL, response, or state change.

## Typical workflow

1. Inspect the target and establish whether it is reachable from the sandbox.
2. Navigate with `page.goto()` or the CLI.
3. Inspect page text, roles, links, and forms before acting.
4. Interact using accessible locators; wait for the resulting state.
5. Capture screenshots, PDFs, console output, or other artifacts when useful.
6. Close the browser and report artifact paths and any limitations.

For local web applications, first start the application if necessary, then use its reachable URL (often `http://127.0.0.1:<port>`). Keep browser state isolated with a fresh context; use `storageState` only when authentication must persist. Treat credentials, cookies, and saved auth files as sensitive.

## Troubleshooting

- `Executable doesn't exist`: run `playwright install --list`; install only the missing browser.
- Browser launch failures: confirm `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` and use `{ headless: true }`.
- Import failures: use the absolute `.mjs` import path shown above; do not assume global npm modules are project-resolvable.
- Timeout or missing elements: inspect the page first, verify the URL, wait for the relevant state, and check whether the content is inside an iframe.
- HTTPS problems in a test environment: use `ignoreHTTPSErrors: true` only when appropriate and mention it in the result.

Never expose passwords, session cookies, or authentication state in logs or committed artifacts.
