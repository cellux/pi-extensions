---
name: playwright
description: Use the globally installed Playwright in the sandbox container for browser automation, web inspection, screenshots, PDFs, and UI verification. Load when a task requires interacting with or testing a web page.
---

# Use Playwright in the sandbox

Use the sandbox's global Playwright installation. Do **not** add Playwright to the project, run `npm install`, or use `npx` unless the user explicitly requests a project-local dependency. Never download browser binaries. If a required browser is missing, report the environment limitation instead of installing it.

## Golden path

1. Confirm that the target URL is reachable from the sandbox.
2. Choose the CLI for a one-shot screenshot or PDF; choose a temporary script for interaction, inspection, or assertions.
3. Inspect page content and structure before acting.
4. Interact through accessible locators and wait for the resulting state.
5. Verify the result and capture useful artifacts.
6. Close the browser and report artifact paths and limitations.

Prefer headless browsers for routine automation, but GUI browsers are available. Use headed workflows such as `playwright open` or `playwright codegen` when it is important for the user to see the browser and actions visually. Choose the mode that best supports the task.

## Choose the smallest interface

### CLI: one-shot capture

Use the global CLI directly for a screenshot or PDF:

```bash
playwright screenshot --full-page https://example.com /tmp/example.png
playwright pdf --paper-format A4 https://example.com /tmp/example.pdf
```

Useful screenshot options:

```bash
playwright screenshot --wait-for-selector 'main' URL /tmp/page.png
playwright screenshot --viewport-size '1280,720' URL /tmp/page.png
playwright screenshot --browser firefox URL /tmp/page.png
playwright screenshot --save-storage /tmp/auth.json URL /tmp/page.png
playwright screenshot --load-storage /tmp/auth.json URL /tmp/page.png
```

Use `playwright --help` or `playwright <command> --help` when exact syntax is uncertain.

### Script: interaction or inspection

Create a temporary `.mjs` script when the task needs multiple actions, assertions, DOM inspection, network handling, authentication, or custom logic.

Import the global package by absolute path. A bare import from `playwright` will not resolve unless the project declares its own dependency.

```bash
cat >/tmp/check-page.mjs <<'EOF'
import { chromium } from '/usr/local/lib/node_modules/playwright/index.mjs';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

  console.log('title:', await page.title());
  console.log('heading:', await page.getByRole('heading').first().textContent());
  await page.screenshot({ path: '/tmp/example.png', fullPage: true });
} finally {
  await browser.close();
}
EOF
node /tmp/check-page.mjs
```

Keep disposable scripts and artifacts under `/tmp`. Put an artifact in the project only when it should be retained, and inspect generated screenshots or PDFs before reporting them.

## Locate and wait reliably

Prefer user-facing locators in this order:

```js
page.getByRole('button', { name: 'Submit' })
page.getByLabel('Email')
page.getByPlaceholder('Search')
page.getByText('Continue')
page.getByTestId('result')
```

Use CSS or XPath only when no semantic locator is available. Prefer Playwright's auto-waiting and web-first assertions. Wait for a meaningful selector, URL, response, or state change instead of sleeping. Use `page.waitForTimeout()` only when no observable state can represent the wait.

If an element is missing, inspect the page first. Check the current URL, visible text, page state, and whether the content is inside an iframe before changing selectors or increasing timeouts.

## Local applications and browser state

For a local application, start it only if necessary and navigate to its sandbox-reachable URL, usually `http://127.0.0.1:<port>`.

Use a fresh browser context by default. Persist `storageState` only when authentication must survive between runs. Treat credentials, cookies, tokens, and saved storage files as secrets: never print them or commit them, and remove temporary auth files when finished.

Use `ignoreHTTPSErrors: true` only for an appropriate test environment, and mention that exception in the result.

## Installed environment

The sandbox provides:

- CLI: `/usr/local/bin/playwright`
- Node package: `/usr/local/lib/node_modules/playwright`
- browser binaries: `/ms-playwright`
- `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`

Verify these only when installation or launch is in doubt:

```bash
command -v playwright
playwright --version
playwright install --list  # inspection only; this does not install anything
```

Chromium and Firefox, including their system libraries, are normally preinstalled. Never run `playwright install <browser>` or use `--with-deps`. If `playwright install --list` shows that a required browser is missing, report the limitation and continue with an available browser only when that still satisfies the task.

## Troubleshooting

- **Browser binary missing:** do not install it; report the limitation or use an already-installed browser if suitable.
- **Browser launch failure:** confirm `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` and launch with `{ headless: true }`.
- **Import failure:** use `/usr/local/lib/node_modules/playwright/index.mjs`; do not assume global npm packages are project-resolvable.
- **Timeout or missing element:** inspect the actual page state, URL, and iframes before changing the timeout.
- **Local page unreachable:** verify that the application is running and listening on an address reachable inside the sandbox.
