/**
 * colab_keep_alive.js
 *
 * 1. Connects to a running Chrome instance via CDP
 * 2. Finds an open Colab tab (or navigates to Colab)
 * 3. Keeps the session alive indefinitely via:
 *    - Random mouse movements across the page
 *    - Random right-clicks (context menu open + close)
 *    - Random scrolling (up/down)
 *    - Passive popup dismissal (same logic as colab_run_all)
 *
 * Does NOT click any interactive Colab UI elements, buttons, or links.
 * Safe to run against an already-running notebook.
 *
 * Env vars:
 *   CLOUDSURF_CDP_PORT     CDP port (injected by CloudSurf)
 *   CLOUDSURF_PROFILE_ID   profile id (injected by CloudSurf)
 */

const puppeteer = require('puppeteer-core');

const CDP_PORT   = process.env.CLOUDSURF_CDP_PORT  || '9222';
const PROFILE_ID = process.env.CLOUDSURF_PROFILE_ID || '(unknown)';

const log = (...a) => console.log(`[colab_keep_alive | ${PROFILE_ID}]`, ...a);

// ── helpers ───────────────────────────────────────────────────────────────────

/** Random integer in [min, max] inclusive */
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

/** Random float in [min, max] */
const randFloat = (min, max) => Math.random() * (max - min) + min;

/** Sleep for ms milliseconds */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Passive popup dismisser ───────────────────────────────────────────────────
// Same conservative logic as colab_run_all — only "dismiss" / "ignore".
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

// ── viewport size helper ──────────────────────────────────────────────────────
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

    // Prefer an existing Colab tab
    let page = pages.find(p => p.url().includes('colab.research.google.com'));
    if (!page) {
      log('No Colab tab found — using first tab');
      page = pages[0];
    }
    if (!page) {
      log('No tabs open — cannot proceed');
      process.exit(1);
    }

    // Navigate to Colab if needed (e.g. blank tab)
    if (!page.url().includes('colab.research.google.com')) {
      log('Navigating to Colab ...');
      await page.goto('https://colab.research.google.com/', {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });
    }

    log(`Keeping alive: ${page.url()}`);

    // Handle any unexpected "leave page" dialogs defensively
    page.on('dialog', async (dialog) => {
      log(`Browser dialog: "${dialog.message()}" — dismissing`);
      try { await dialog.dismiss(); } catch (_) {}
    });

    // ── keep-alive loop ───────────────────────────────────────────────────
    // Interval between activity bursts: 20–40 seconds
    const INTERVAL_MIN_MS  = 20_000;
    const INTERVAL_MAX_MS  = 40_000;
    const SAFETY_CAP_MS    = 12 * 60 * 60 * 1000; // 12h hard cap
    const loopStart = Date.now();
    let tick = 0;

    while (Date.now() - loopStart < SAFETY_CAP_MS) {
      const wait = randInt(INTERVAL_MIN_MS, INTERVAL_MAX_MS);
      await sleep(wait);
      tick++;

      // Guard: page may have been replaced / navigated
      try {
        // ── 1. Get current viewport dimensions ───────────────────────────
        let vp;
        try {
          vp = await page.evaluate(scriptViewportSize);
        } catch (_) {
          vp = { width: 1280, height: 800 };
        }
        const { width, height } = vp;

        // ── 2. Pick an activity at random ─────────────────────────────────
        //   0-2  → mouse move (most common, least intrusive)
        //   3    → right-click + escape (context menu flicker)
        //   4    → scroll
        const activity = randInt(0, 4);

        if (activity <= 2) {
          // ── Mouse move ──────────────────────────────────────────────────
          // Stay away from the top toolbar (top 80px) and left sidebar to
          // avoid accidentally hovering over interactive controls.
          const x = randInt(Math.floor(width  * 0.15), Math.floor(width  * 0.85));
          const y = randInt(Math.floor(height * 0.20), Math.floor(height * 0.90));
          await page.mouse.move(x, y, { steps: randInt(5, 15) });
          log(`[tick ${tick}] mouse move → (${x}, ${y})`);

        } else if (activity === 3) {
          // ── Right-click then Escape ─────────────────────────────────────
          // Target a "safe" area: the cell output / blank space in the
          // middle of the page (avoids toolbar, cell gutters, run buttons).
          const x = randInt(Math.floor(width  * 0.25), Math.floor(width  * 0.75));
          const y = randInt(Math.floor(height * 0.30), Math.floor(height * 0.85));
          await page.mouse.move(x, y, { steps: randInt(3, 8) });
          await page.mouse.click(x, y, { button: 'right' });
          await sleep(randInt(300, 700));          // let context menu appear
          await page.evaluate(scriptCloseContextMenu);
          await sleep(200);
          log(`[tick ${tick}] right-click + escape at (${x}, ${y})`);

        } else {
          // ── Scroll ──────────────────────────────────────────────────────
          // Scroll up or down by a small random amount, then back.
          const deltaY = randInt(100, 400) * (Math.random() < 0.5 ? 1 : -1);
          await page.mouse.wheel({ deltaY });
          await sleep(randInt(500, 1200));
          await page.mouse.wheel({ deltaY: -deltaY }); // restore position
          log(`[tick ${tick}] scroll deltaY=${deltaY}`);
        }

        // ── 3. Passive popup sweep (after every activity) ─────────────────
        const sweep = await page.evaluate(scriptDismissPopups);
        if (sweep !== 'none') {
          log(`[tick ${tick}] popup sweep: ${sweep}`);
        }

      } catch (err) {
        // Non-fatal — page may be reloading, CDP frame detached, etc.
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
