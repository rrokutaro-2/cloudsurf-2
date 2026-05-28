/**
 * colab_run_all.js
 *
 * 1. Connects to a running Chrome instance via CDP
 * 2. Dismisses any Colab popups/warnings (storage, session, etc.)
 * 3. Finds and clicks a specific notebook by name (CLOUDSURF_NOTEBOOK)
 * 4. Handles any "leave page" browser dialog
 * 5. Clicks "Connect" button if present (pre-step before Run all)
 * 6. Clicks "Run all" using findDeep (Shadow DOM aware)
 * 7. Stays alive polling for popups until the notebook finishes running
 *
 * Env vars:
 *   CLOUDSURF_CDP_PORT     CDP port (injected by CloudSurf)
 *   CLOUDSURF_PROFILE_ID   profile id (injected by CloudSurf)
 *   CLOUDSURF_NOTEBOOK     notebook name to open, e.g. "myproject.ipynb"
 *                          (set as a Codespace secret)
 */

const puppeteer = require('puppeteer-core');

const CDP_PORT    = process.env.CLOUDSURF_CDP_PORT || '9222';
const PROFILE_ID  = process.env.CLOUDSURF_PROFILE_ID || '(unknown)';
const NOTEBOOK    = (process.env.CLOUDSURF_NOTEBOOK || '').trim();

const log = (...a) => console.log(`[colab_run_all | ${PROFILE_ID}]`, ...a);

if (!NOTEBOOK) {
  log('WARNING: CLOUDSURF_NOTEBOOK is not set — will skip notebook selection and go straight to Run all');
}

// ── clickDeepByText ───────────────────────────────────────────────────────────
// Walks Light DOM + Shadow DOM, finds the innermost element whose
// textContent or aria-label contains the target word, clicks it.
// Returns true if something was clicked.
const FN_CLICK_DEEP_BY_TEXT = `
function clickDeepByText(word, root = document, clickAll = false) {
  const wordLower = word.toLowerCase();
  const foundElements = [];

  function search(node) {
    if (node.shadowRoot) search(node.shadowRoot);
    if (node.children) {
      for (const child of node.children) search(child);
    }
    const hasText = node.textContent?.toLowerCase().includes(wordLower);
    const hasAria = node.getAttribute?.('aria-label')?.toLowerCase().includes(wordLower);
    if (hasText || hasAria) {
      const childMatch = Array.from(node.children || []).some(child =>
        child.textContent?.toLowerCase().includes(wordLower)
      );
      if (!childMatch) foundElements.push(node);
    }
  }

  search(root);

  if (foundElements.length > 0) {
    if (clickAll) {
      foundElements.forEach(el => el.click());
    } else {
      foundElements[0].click();
    }
    return true;
  }
  return false;
}
`;

// ── findDeep ──────────────────────────────────────────────────────────────────
// Exact-match version used for "Run all" and "Connect" buttons.
const FN_FIND_DEEP = `
function findDeep(root, targetText) {
  if (root.textContent && root.textContent.trim().toLowerCase() === targetText.toLowerCase()) {
    return root;
  }
  if (root.getAttribute && root.getAttribute('aria-label')?.toLowerCase().includes(targetText.toLowerCase())) {
    return root;
  }
  const children = root.children || [];
  for (const child of children) {
    const found = findDeep(child, targetText);
    if (found) return found;
  }
  if (root.shadowRoot) {
    const found = findDeep(root.shadowRoot, targetText);
    if (found) return found;
  }
  return null;
}
`;

// ── Step 1: click notebook in picker ─────────────────────────────────────────
// Returns "clicked" | "not_found" | "skipped"
const scriptClickNotebook = (notebook) => `
(function() {
  ${FN_CLICK_DEEP_BY_TEXT}
  if (!${JSON.stringify(notebook)}) return 'skipped';
  const clicked = clickDeepByText(${JSON.stringify(notebook)});
  return clicked ? 'clicked' : 'not_found';
})();
`;

// Poll version — picker may not have rendered yet
const scriptPollNotebook = (notebook) => `
new Promise((resolve) => {
  ${FN_CLICK_DEEP_BY_TEXT}
  let attempts = 0;
  const iv = setInterval(() => {
    attempts++;
    const clicked = clickDeepByText(${JSON.stringify(notebook)});
    if (clicked) {
      clearInterval(iv);
      resolve('clicked_after_' + attempts + '_polls');
    } else if (attempts >= 60) {  // 30s
      clearInterval(iv);
      resolve('timeout');
    }
  }, 500);
});
`;

// ── Popup dismisser ───────────────────────────────────────────────────────────
// Dismisses all known Colab popups/warnings. Returns list of what was dismissed.
// Covers: storage warnings, session recovery, runtime crash dialogs, cookie
// consent, "you are close to the usage limit", "runtime disconnected" toasts.
const scriptDismissPopups = `
(function() {
  const dismissed = [];

  // Only click buttons that unambiguously mean "go away" — nothing else.
  const DISMISS_TEXTS = [
    'dismiss',
    'ignore',
  ];

  // Aria-labels / text patterns that indicate a dismissable popup
  const POPUP_SELECTORS = [
    // Material dialogs
    'paper-dialog', 'colab-dialog', '.modal', '.dialog',
    // Colab-specific warning toasts
    'colab-toast', '#colab-toast-container',
    // Generic overlays
    '[role="dialog"]', '[role="alertdialog"]',
  ];

  function tryClickButton(root) {
    const all = root.querySelectorAll ? root.querySelectorAll('button, paper-button, [role="button"]') : [];
    for (const btn of all) {
      const txt = (btn.textContent || btn.getAttribute('aria-label') || '').trim().toLowerCase();
      if (DISMISS_TEXTS.some(t => txt === t || txt.startsWith(t))) {
        btn.click();
        dismissed.push(txt);
        return true;
      }
    }
    // Also check shadow roots
    const children = root.children || [];
    for (const child of children) {
      if (child.shadowRoot && tryClickButton(child.shadowRoot)) return true;
    }
    return false;
  }

  // Check each known popup container
  for (const sel of POPUP_SELECTORS) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      // Only target visible elements
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      tryClickButton(el);
    }
  }

  // Also scan the full document for any visible dialog-like element we missed
  tryClickButton(document.body);

  return dismissed.length > 0 ? ('dismissed: ' + dismissed.join(', ')) : 'none';
})();
`;

// ── isNotebookRunning ─────────────────────────────────────────────────────────
// Returns true if any cell still has a running indicator.
const scriptIsRunning = `
(function() {
  // Colab shows a spinner or "stop" icon on running cells
  const runningCells = document.querySelectorAll(
    '.cell-execution-count[data-execution-count="*"], ' +
    'colab-run-button[running], ' +
    '.running-indicator, ' +
    '[data-status="running"]'
  );
  if (runningCells.length > 0) return true;
  // Fallback: look for the animated progress bar Colab shows during execution
  const progress = document.querySelector('.progress-bar-animation, .execution-progress');
  return !!progress;
})();
`;

// ── Connect button (pre-step before Run all) ──────────────────────────────────
// Looks for an exact "Connect" button only — ignores "Connecting", "Reconnect",
// "Connected", etc. Clicks it if found. Non-fatal if absent.
const scriptClickConnect = `
(function() {
  ${FN_FIND_DEEP}
  const btn = findDeep(document.querySelector('*'), 'Connect');
  if (btn) { btn.click(); return 'clicked'; }
  return 'not_found';
})();
`;

const scriptRunAll = `
(function() {
  ${FN_FIND_DEEP}
  const toolbar = document.querySelector('#top-toolbar') || document.querySelector('*');
  const btn = findDeep(toolbar, 'Run all');
  if (btn) { btn.click(); return 'clicked'; }
  return 'not_found';
})();
`;

const scriptPollRunAll = `
new Promise((resolve) => {
  ${FN_FIND_DEEP}
  let attempts = 0;
  const iv = setInterval(() => {
    attempts++;
    const btn = findDeep(document.querySelector('*'), 'Run all');
    if (btn) {
      btn.click();
      clearInterval(iv);
      resolve('clicked_after_' + attempts + '_polls');
    } else if (attempts >= 120) {  // 60s — notebook load can be slow
      clearInterval(iv);
      resolve('timeout');
    }
  }, 500);
});
`;

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  let browser;
  try {
    log(`Connecting to Chrome on port ${CDP_PORT} ...`);
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${CDP_PORT}`,
      defaultViewport: null,
    });

    const pages = await browser.pages();
    log(`${pages.length} tab(s) open`);

    let page = pages.find(p => p.url().includes('colab.research.google.com'));
    if (!page) {
      log('No Colab tab — using first tab');
      page = pages[0];
    }
    if (!page) {
      log('No tabs open — cannot proceed');
      process.exit(1);
    }

    // Navigate to Colab if needed
    if (!page.url().includes('colab.research.google.com')) {
      log('Navigating to Colab ...');
      await page.goto('https://colab.research.google.com/', {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });

      await page.reload({ waitUntil: "networkidle2" });
    }

    log(`Tab: ${page.url()}`);

    // ── Handle "leave page" dialog BEFORE any clicks ──────────────────────
    // Set up the handler early so it fires if the dialog appears at any point
    page.on('dialog', async (dialog) => {
      log(`Browser dialog: "${dialog.message()}" — accepting`);
      try { await dialog.accept(); } catch (_) {}
    });

    // ── Step 1: Open the notebook ─────────────────────────────────────────
    if (NOTEBOOK) {
      log(`Looking for notebook: "${NOTEBOOK}" ...`);

      let result = await page.evaluate(scriptClickNotebook(NOTEBOOK));
      log(`Immediate notebook click: ${result}`);

      if (result === 'not_found') {
        log('Not found immediately — polling for picker to appear ...');
        result = await page.evaluate(scriptPollNotebook(NOTEBOOK));
        log(`Poll result: ${result}`);
      }

      if (result === 'timeout') {
        log(`Could not find notebook "${NOTEBOOK}" after 30s`);
        process.exit(1);
      }

      // Wait for navigation after clicking the notebook.
      // The page may reload or navigate — wait for it to settle.
      log('Waiting for page to load after notebook click ...');
      try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
      } catch (_) {
        // waitForNavigation times out if the page was already on the notebook URL
        // (e.g. opened in same tab without a full nav). That's fine — continue.
        log('No navigation detected — assuming already on notebook page');
      }

      log(`Page after notebook open: ${page.url()}`);
    } else {
      log('No CLOUDSURF_NOTEBOOK set — skipping notebook selection');
    }

    // ── Step 2: Dismiss popups ────────────────────────────────────────────
    log('Dismissing any pre-run popups ...');
    let dismissed = await page.evaluate(scriptDismissPopups);
    log(`Pre-run popup sweep: ${dismissed}`);

    // ── Step 3: Click "Connect" if present ───────────────────────────────
    // This is a best-effort pre-step. "Connect" may not be present if the
    // runtime is already connected or auto-connects — that is fine, we
    // proceed either way.
    log('Checking for "Connect" button (pre-step) ...');
    const connectResult = await page.evaluate(scriptClickConnect);
    log(`Connect button: ${connectResult}`);
    if (connectResult === 'clicked') {
      // Brief pause to let the connection handshake start before Run all
      await new Promise(r => setTimeout(r, 2000));
    }

    // ── Step 4: Attempting "Run all" click ────────────────────────────────
    log('Attempting "Run all" click ...');
    let runResult = await page.evaluate(scriptRunAll);
    log(`Immediate Run all: ${runResult}`);

    if (runResult === 'not_found') {
      log('Polling for Run all button (up to 60s) ...');
      runResult = await page.evaluate(scriptPollRunAll);
      log(`Poll result: ${runResult}`);
    }

    if (runResult === 'timeout') {
      log('Could not find "Run all" button after 60s');
      process.exit(1);
    }

    log('"Run all" clicked — will keep re-clicking every 10-15s in case runtime was not ready ...');

    // ── Step 5: Re-click Run all every 10-15s + dismiss popups ───────────
    // Colab's "Run all" button exists in the DOM before the runtime is
    // actually connected, so the first click can land on a not-yet-ready
    // runtime and silently do nothing. Re-clicking every 10-15s ensures
    // at least one click lands while the runtime is live.
    // launch.py's RUN_TIME hard-kills this process, so the 6h cap below
    // is just a safety net — we'll be killed long before that.
    const WATCH_INTERVAL_BASE_MS = 10000;  // 10s base
    const WATCH_INTERVAL_JITTER  =  5000;  // +0-5s random jitter -> 10-15s total
    const WATCH_MAX_MS           = 6 * 60 * 60 * 1000; // safety cap
    const watchStart = Date.now();
    let watchTick = 0;

    while (Date.now() - watchStart < WATCH_MAX_MS) {
      const interval = WATCH_INTERVAL_BASE_MS + Math.floor(Math.random() * WATCH_INTERVAL_JITTER);
      await new Promise(r => setTimeout(r, interval));
      watchTick++;

      try {
        // Dismiss any popups first so they don't block the button
        const sweep = await page.evaluate(scriptDismissPopups);
        if (sweep !== 'none') {
          log(`[tick ${watchTick}] Dismissed popup: ${sweep}`);
        }

        // Re-click Run all — if runtime is now ready this will start it;
        // if already running Colab ignores or re-confirms the click safely.
        // const reClick = await page.evaluate(scriptRunAll);
        // log(`[tick ${watchTick}] Run all: ${reClick}`);
      } catch (err) {
        // Page may be navigating/reloading — not fatal
        log(`[tick ${watchTick}] Page eval error (may be navigating): ${err.message}`);
      }
    }

    log('Watch period ended (6h safety cap reached).');

  } catch (err) {
    console.error(`[colab_run_all | ${PROFILE_ID}] Fatal: ${err.message}`);
    process.exit(1);
  } finally {
    if (browser) {
      try { await browser.disconnect(); } catch (_) {}
    }
  }
})();
