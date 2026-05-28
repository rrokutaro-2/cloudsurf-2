/**
 * colab_keep_alive.js
 *
 * 1. Connects to a running Chrome instance via CDP
 * 2. Dismisses any Colab popups/warnings
 * 3. Finds and clicks a specific notebook by name (CLOUDSURF_NOTEBOOK)
 * 4. Handles any "leave page" browser dialog
 * 5. Keeps the session alive indefinitely via:
 *    - Random mouse movements across the page
 *    - Random right-clicks (context menu open + close)
 *    - Random scrolling (up/down)
 *    - Passive popup dismissal
 *
 * Does NOT click Connect, Run all, or any Colab action buttons.
 *
 * Env vars:
 *   CLOUDSURF_CDP_PORT     CDP port (injected by CloudSurf)
 *   CLOUDSURF_PROFILE_ID   profile id (injected by CloudSurf)
 *   CLOUDSURF_NOTEBOOK     notebook name to open, e.g. "myproject.ipynb"
 */

const puppeteer = require('puppeteer-core');

const CDP_PORT   = process.env.CLOUDSURF_CDP_PORT  || '9222';
const PROFILE_ID = process.env.CLOUDSURF_PROFILE_ID || '(unknown)';
const NOTEBOOK   = (process.env.CLOUDSURF_NOTEBOOK || '').trim();

const log = (...a) => console.log(`[colab_keep_alive | ${PROFILE_ID}]`, ...a);

if (!NOTEBOOK) {
  log('WARNING: CLOUDSURF_NOTEBOOK is not set — will skip notebook selection and go straight to keep-alive');
}

// ── helpers ───────────────────────────────────────────────────────────────────

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep   = (ms) => new Promise(r => setTimeout(r, ms));

// ── clickDeepByText ───────────────────────────────────────────────────────────
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

// ── Step 1: click notebook in picker ─────────────────────────────────────────
const scriptClickNotebook = (notebook) => `
(function() {
  ${FN_CLICK_DEEP_BY_TEXT}
  if (!${JSON.stringify(notebook)}) return 'skipped';
  const clicked = clickDeepByText(${JSON.stringify(notebook)});
  return clicked ? 'clicked' : 'not_found';
})();
`;

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

// ── Passive popup dismisser ───────────────────────────────────────────────────
const scriptDismissPopups = `
(function() {
  const dismissed = [];
  const DISMISS_TEXTS = ['dismiss', 'ignore'];
  const POPUP_SELECTORS = [
    'paper-dialog', 'colab-dialog', '.modal', '.dialog',
    'colab-toast', '#colab-toast-container',
    '[role="dialog"]', '[role="alertdialog"]',
  ];

  function tryClickButton(root) {
    const all = root.querySelectorAll
      ? root.querySelectorAll('button, paper-button, [role="button"]')
      : [];
    for (const btn of all) {
      const txt = (btn.textContent || btn.getAttribute('aria-label') || '').trim().toLowerCase();
      if (DISMISS_TEXTS.some(t => txt === t || txt.startsWith(t))) {
        btn.click();
        dismissed.push(txt);
        return true;
      }
    }
    const children = root.children || [];
    for (const child of children) {
      if (child.shadowRoot && tryClickButton(child.shadowRoot)) return true;
    }
    return false;
  }

  for (const sel of POPUP_SELECTORS) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      tryClickButton(el);
    }
  }

  tryClickButton(document.body);
  return dismissed.length > 0 ? ('dismissed: ' + dismissed.join(', ')) : 'none';
})();
`;

// Close any open context menu by pressing Escape
const scriptCloseContextMenu = `
(function() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keyup',  { key: 'Escape', bubbles: true }));
})();
`;

const scriptViewportSize = `
({ width: window.innerWidth, height: window.innerHeight })
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
      await page.reload({ waitUntil: 'networkidle2' });
    }

    log(`Tab: ${page.url()}`);

    // Handle "leave page" dialogs at any point
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

      log('Waiting for page to load after notebook click ...');
      try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
      } catch (_) {
        log('No navigation detected — assuming already on notebook page');
      }

      log(`Page after notebook open: ${page.url()}`);
    } else {
      log('No CLOUDSURF_NOTEBOOK set — skipping notebook selection');
    }

    // ── Step 2: Dismiss popups ────────────────────────────────────────────
    log('Dismissing any pre-keep-alive popups ...');
    const dismissed = await page.evaluate(scriptDismissPopups);
    log(`Pre-loop popup sweep: ${dismissed}`);

    // ── Step 3: Keep-alive loop ───────────────────────────────────────────
    log('Entering keep-alive loop ...');

    const INTERVAL_MIN_MS = 20_000;
    const INTERVAL_MAX_MS = 40_000;
    const SAFETY_CAP_MS   = 12 * 60 * 60 * 1000; // 12h hard cap
    const loopStart = Date.now();
    let tick = 0;

    while (Date.now() - loopStart < SAFETY_CAP_MS) {
      const wait = randInt(INTERVAL_MIN_MS, INTERVAL_MAX_MS);
      await sleep(wait);
      tick++;

      try {
        let vp;
        try {
          vp = await page.evaluate(scriptViewportSize);
        } catch (_) {
          vp = { width: 1280, height: 800 };
        }
        const { width, height } = vp;

        // 0-2 → mouse move, 3 → right-click + escape, 4 → scroll
        const activity = randInt(0, 4);

        if (activity <= 2) {
          // Stay away from top toolbar (top 80px) and left sidebar
          const x = randInt(Math.floor(width  * 0.15), Math.floor(width  * 0.85));
          const y = randInt(Math.floor(height * 0.20), Math.floor(height * 0.90));
          await page.mouse.move(x, y, { steps: randInt(5, 15) });
          log(`[tick ${tick}] mouse move → (${x}, ${y})`);

        } else if (activity === 3) {
          // Safe zone: middle of page, away from any buttons
          const x = randInt(Math.floor(width  * 0.25), Math.floor(width  * 0.75));
          const y = randInt(Math.floor(height * 0.30), Math.floor(height * 0.85));
          await page.mouse.move(x, y, { steps: randInt(3, 8) });
          await page.mouse.click(x, y, { button: 'right' });
          await sleep(randInt(300, 700));
          await page.evaluate(scriptCloseContextMenu);
          await sleep(200);
          log(`[tick ${tick}] right-click + escape at (${x}, ${y})`);

        } else {
          const deltaY = randInt(100, 400) * (Math.random() < 0.5 ? 1 : -1);
          await page.mouse.wheel({ deltaY });
          await sleep(randInt(500, 1200));
          await page.mouse.wheel({ deltaY: -deltaY });
          log(`[tick ${tick}] scroll deltaY=${deltaY}`);
        }

        // Passive popup sweep after every activity
        const sweep = await page.evaluate(scriptDismissPopups);
        if (sweep !== 'none') {
          log(`[tick ${tick}] popup sweep: ${sweep}`);
        }

      } catch (err) {
        log(`[tick ${tick}] recoverable error: ${err.message}`);
      }
    }

    log('Safety cap (12h) reached — exiting.');

  } catch (err) {
    console.error(`[colab_keep_alive | ${PROFILE_ID}] Fatal: ${err.message}`);
    process.exit(1);
  } finally {
    if (browser) {
      try { await browser.disconnect(); } catch (_) {}
    }
  }
})();
