/**
 * youtube_warmup.js
 *
 * Robust YouTube account warmup script using Puppeteer (CDP connection).
 * Navigates by direct URL, uses stable selectors, dismisses all popups/dialogs.
 *
 * Env vars (optional):
 *   CLOUDSURF_CDP_PORT     CDP port (default 9222)
 *   CLOUDSURF_PROFILE_ID   For logging
 */

const puppeteer = require('puppeteer-core');

const CDP_PORT = process.env.CLOUDSURF_CDP_PORT || '9222';
const PROFILE_ID = process.env.CLOUDSURF_PROFILE_ID || 'youtube-warmup';

const log = (...a) => console.log(`[yt-warmup | ${PROFILE_ID}]`, ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const humanDelay = async (base = 800, variance = 600) => sleep(base + randomInt(0, variance));

// ── Mouse movement ────────────────────────────────────────────────────────
const humanMouseMove = async (page, targetX, targetY, steps = 20) => {
  const startX = randomInt(200, 800);
  const startY = randomInt(150, 500);
  for (let i = 0; i <= steps; i++) {
    const x = startX + (targetX - startX) * (i / steps) + (Math.random() * 10 - 5);
    const y = startY + (targetY - startY) * (i / steps) + (Math.random() * 10 - 5);
    await page.mouse.move(Math.floor(x), Math.floor(y));
    await sleep(8 + Math.random() * 15);
  }
};

// ── Human typing ──────────────────────────────────────────────────────────
const humanType = async (page, text) => {
  for (const char of text) {
    if (Math.random() < 0.04) {
      await page.keyboard.type('abcdefghijklmnopqrstuvwxyz'[randomInt(0, 25)]);
      await sleep(randomInt(80, 180));
      await page.keyboard.press('Backspace');
      await sleep(randomInt(60, 120));
    }
    await page.keyboard.type(char);
    await sleep(randomInt(60, 180));
  }
};

// ── Safe navigation ───────────────────────────────────────────────────────
const goHome = async (page) => {
  await page.goto('https://www.youtube.com', { waitUntil: 'networkidle2', timeout: 30000 });
  await humanDelay(1200, 800);
};

const safeGoBack = async (page) => {
  try {
    await page.goBack({ waitUntil: 'networkidle2', timeout: 15000 });
  } catch {
    await goHome(page);
  }
};

// ── Dialog / popup dismissal ──────────────────────────────────────────────

// Handles native browser dialogs (alert, confirm, beforeunload, prompt)
const setupDialogHandler = (page) => {
  page.on('dialog', async (dialog) => {
    log(`Browser dialog [${dialog.type()}]: "${dialog.message()}" — dismissing`);
    try {
      await dialog.dismiss();
    } catch {
      await dialog.accept().catch(() => {});
    }
  });
};

// Dismisses YouTube overlay popups: sign-in nags, survey prompts,
// premium upsells, skip-ad buttons, session expiry modals, etc.
const dismissYouTubePopups = async (page) => {
  const DISMISS_SELECTORS = [
    // Skip ad buttons
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    // "Dismiss" / "No thanks" / "Not now" overlays
    'tp-yt-paper-dialog yt-button-renderer:last-child button',
    'ytd-popup-container yt-button-renderer button',
    // Sign-in / account picker dismiss
    '#dismiss-button button',
    'yt-button-shape button[aria-label*="Dismiss"]',
    'yt-button-shape button[aria-label*="No thanks"]',
    'yt-button-shape button[aria-label*="Skip"]',
    // Cookie/consent re-appearance
    'button[aria-label*="Accept"]',
    // Survey / feedback
    'button.yt-survey-dismiss-button',
    // Generic modal close
    'button.yt-icon-button[aria-label="Close"]',
    '#close-button button',
    // "Get the app" / "Continue in browser" prompts
    '.yt-mealbar-promo-renderer button[aria-label*="No"]',
    'ytd-mealbar-promo-renderer #dismiss-button button',
  ];

  let dismissed = 0;
  for (const sel of DISMISS_SELECTORS) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        const visible = await btn.isIntersectingViewport().catch(() => false);
        if (visible) {
          await btn.click();
          dismissed++;
          await sleep(350);
        }
      }
    } catch {
      // Selector didn't match, keep going
    }
  }

  if (dismissed > 0) log(`Dismissed ${dismissed} overlay(s)`);
  return dismissed;
};

const dismissAndContinue = async (page) => {
  await dismissYouTubePopups(page);
  await humanDelay(300, 200);
};

// ── Consent handler ───────────────────────────────────────────────────────
const handleConsent = async (page) => {
  try {
    const buttons = await page.$$('button, tp-yt-paper-button');
    for (const btn of buttons) {
      const text = await btn.evaluate(el => el.innerText?.toLowerCase() || '');
      if (text.includes('accept all') || text.includes('i agree') || text.includes('agree')) {
        await btn.click();
        log('Consent accepted');
        await humanDelay(1200);
        return;
      }
    }
  } catch {
    log('No consent dialog detected');
  }
};

// ── Login check ───────────────────────────────────────────────────────────
const assertLoggedIn = async (page) => {
  await page.waitForSelector('ytd-app', { timeout: 15000 });
  const loggedIn = await page.evaluate(() => {
    return !!(
      document.querySelector('button#avatar-btn') ||
      document.querySelector('yt-img-shadow#avatar') ||
      document.querySelector('a[href="/feed/subscriptions"]')
    );
  });
  if (!loggedIn) throw new Error('Not logged in — sign in first then re-run.');
  log('Login verified ✓');
};

// ── Scroll helper ─────────────────────────────────────────────────────────
const naturalScroll = async (page, scrolls = 5) => {
  for (let i = 0; i < scrolls; i++) {
    const amount = randomInt(300, 600);
    await page.evaluate((amt) => window.scrollBy({ top: amt, behavior: 'smooth' }), amount);
    await humanDelay(800, 1000);

    if (Math.random() > 0.7) {
      await page.evaluate(() => window.scrollBy({ top: -150, behavior: 'smooth' }));
      await humanDelay(500, 400);
    }

    await humanMouseMove(page, randomInt(200, 1000), randomInt(150, 600));
  }
};

// ── Click a video from the current feed ──────────────────────────────────
// Uses stable href pattern — works regardless of YouTube's internal component names
const clickFeedVideo = async (page, skipCount = 2) => {
  const clicked = await page.evaluate((skip) => {
    const links = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
    const unique = [...new Map(links.map(l => [l.href, l])).values()];
    if (unique.length <= skip) return false;
    const pick = unique[skip + Math.floor(Math.random() * Math.min(5, unique.length - skip))];
    pick.scrollIntoView({ behavior: 'smooth', block: 'center' });
    pick.click();
    return true;
  }, skipCount);
  return clicked;
};

// ── Watch currently loaded video ──────────────────────────────────────────
const watchCurrentVideo = async (page, minMs = 25000, maxMs = 65000) => {
  await humanDelay(2000, 1500);

  // Dismiss anything blocking the player before interacting
  await dismissAndContinue(page);

  await page.waitForSelector('video', { timeout: 20000 }).catch(() => {
    log('  Video element not found within timeout');
  });

  // Use real video duration if available (watch 30–60% of it)
  const watchMs = await page.evaluate((min, max) => {
    const v = document.querySelector('video');
    if (v && v.duration && !isNaN(v.duration) && v.duration > 0) {
      const pct = 0.30 + Math.random() * 0.30;
      return Math.floor(v.duration * pct * 1000);
    }
    return min + Math.floor(Math.random() * (max - min));
  }, minMs, maxMs);

  log(`  Watching for ~${Math.round(watchMs / 1000)}s`);
  const deadline = Date.now() + watchMs;

  while (Date.now() < deadline) {
    await humanDelay(randomInt(4000, 9000), 0);

    // Check for and dismiss any mid-video popups (e.g. skip ad)
    await dismissYouTubePopups(page);

    if (Math.random() > 0.72) await page.keyboard.press('k').catch(() => {}); // pause/play
    if (Math.random() > 0.82) await page.keyboard.press('ArrowRight').catch(() => {}); // skip 5s
    await humanMouseMove(page, randomInt(300, 900), randomInt(200, 500));
  }
};

// ── Homepage browsing ─────────────────────────────────────────────────────
const browseHomepage = async (page) => {
  log('Browsing homepage feed...');
  await goHome(page);
  await dismissAndContinue(page);
  await naturalScroll(page, randomInt(6, 10));
};

// ── Shorts ────────────────────────────────────────────────────────────────
const watchShorts = async (page) => {
  log('Navigating to Shorts...');
  await page.goto('https://www.youtube.com/shorts', { waitUntil: 'networkidle2', timeout: 30000 });
  await humanDelay(2000, 1000);
  await dismissAndContinue(page);

  const count = randomInt(5, 9);
  log(`Watching ${count} Shorts...`);

  for (let i = 0; i < count; i++) {
    log(`  Short ${i + 1}/${count}`);

    // Dismiss anything that popped up between shorts
    await dismissYouTubePopups(page);

    if (Math.random() > 0.5) {
      await page.keyboard.press('k').catch(() => {});
      await humanDelay(400, 200);
      await page.keyboard.press('k').catch(() => {});
    }

    await humanMouseMove(page, randomInt(400, 800), randomInt(300, 600));
    await humanDelay(randomInt(3000, 6000), 0);

    // ArrowDown is YouTube's native shortcut to advance to next Short
    await page.keyboard.press('ArrowDown').catch(() => {});
    await humanDelay(900, 600);
  }
};

// ── Subscriptions feed ────────────────────────────────────────────────────
const browseSubscriptions = async (page) => {
  log('Browsing subscriptions feed...');
  await page.goto('https://www.youtube.com/feed/subscriptions', {
    waitUntil: 'networkidle2',
    timeout: 30000,
  });
  await humanDelay(1500, 800);
  await dismissAndContinue(page);
  await naturalScroll(page, randomInt(4, 7));

  const clicked = await clickFeedVideo(page, 0);
  if (clicked) {
    await watchCurrentVideo(page, 20000, 50000);
    await safeGoBack(page);
    await dismissAndContinue(page);
  }
};

// ── Search queries ────────────────────────────────────────────────────────
const SEARCH_QUERIES = [
  'how to make pasta carbonara',
  'best hiking trails for beginners',
  'lo fi hip hop study music',
  'how does a car engine work',
  'beginner guitar lessons',
  'home workout no equipment',
  'nature documentary 2024',
  'funny cat compilation',
  'how to learn a new language fast',
  'space exploration news',
  'easy meal prep ideas',
  'mindfulness meditation for sleep',
  'history of ancient rome',
  'how to fix a leaky faucet',
  'street food around the world',
  'chess for beginners tutorial',
  'diy home decoration ideas',
  'best road trips europe',
  'how to start investing basics',
  'wildlife photography tips',
];

// ── Search & watch ────────────────────────────────────────────────────────
const searchAndWatch = async (page, query) => {
  log(`Searching: "${query}"`);

  // Navigate via URL — far more reliable than clicking the search box
  const encoded = encodeURIComponent(query);
  await page.goto(`https://www.youtube.com/results?search_query=${encoded}`, {
    waitUntil: 'networkidle2',
    timeout: 30000,
  });
  await humanDelay(2000, 1000);
  await dismissAndContinue(page);

  // Scroll results to simulate scanning
  await naturalScroll(page, randomInt(2, 4));

  // Skip index 0 (often a promoted/ad result)
  const clicked = await clickFeedVideo(page, 1);
  if (!clicked) {
    log('  No results found, skipping');
    return;
  }

  await watchCurrentVideo(page, 25000, 70000);
  await safeGoBack(page);
  await dismissAndContinue(page);
  await humanDelay(1000, 800);
};

// ── Homepage video watch ──────────────────────────────────────────────────
const watchHomepageVideos = async (page) => {
  const count = randomInt(2, 3);
  log(`Watching ${count} homepage videos...`);

  await goHome(page);
  await dismissAndContinue(page);
  await naturalScroll(page, 3);

  for (let i = 0; i < count; i++) {
    log(`  Homepage video ${i + 1}/${count}`);
    try {
      const clicked = await clickFeedVideo(page, 2);
      if (!clicked) {
        log('  No thumbnails found, skipping');
        continue;
      }
      await watchCurrentVideo(page);
      await safeGoBack(page);
      await dismissAndContinue(page);
      await humanDelay(1500, 1000);
      await naturalScroll(page, randomInt(2, 4));
    } catch (e) {
      log(`  Error: ${e.message}`);
      await goHome(page);
    }
  }
};

// ── Main orchestrator ─────────────────────────────────────────────────────
const warmupScript = async (page) => {
  log('Starting warmup sequence...');

  // Set up native browser dialog handler first — before any navigation
  setupDialogHandler(page);

  // 1. Homepage
  log('Step 1: Homepage');
  await page.goto('https://www.youtube.com', { waitUntil: 'networkidle2', timeout: 45000 });
  await humanDelay(1500, 800);
  await handleConsent(page);
  await dismissAndContinue(page);
  await assertLoggedIn(page);
  await browseHomepage(page);

  // 2. Shorts
  log('Step 2: Shorts');
  try {
    await watchShorts(page);
  } catch (e) {
    log(`Shorts failed: ${e.message} — continuing`);
    await goHome(page).catch(() => {});
  }

  // 3. Idle gap (simulates user getting distracted between sessions)
  const idleMs = randomInt(20000, 45000);
  log(`Step 3: Idle for ~${Math.round(idleMs / 1000)}s`);
  await sleep(idleMs);

  // 4. Subscriptions
  log('Step 4: Subscriptions');
  try {
    await browseSubscriptions(page);
  } catch (e) {
    log(`Subscriptions failed: ${e.message} — continuing`);
    await goHome(page).catch(() => {});
  }

  // 5. Search & watch
  log('Step 5: Search & watch');
  const queries = [...SEARCH_QUERIES].sort(() => Math.random() - 0.5).slice(0, randomInt(2, 3));
  for (const q of queries) {
    try {
      await searchAndWatch(page, q);
      await sleep(randomInt(8000, 15000));
    } catch (e) {
      log(`Search error: ${e.message}`);
      await goHome(page).catch(() => {});
    }
  }

  // 6. Homepage videos
  log('Step 6: Homepage videos');
  await watchHomepageVideos(page);

  // 7. Final scroll
  log('Step 7: Final feed scroll');
  await goHome(page);
  await dismissAndContinue(page);
  await naturalScroll(page, randomInt(3, 5));

  log('Warmup complete ✓');
};

// ── Entry point ───────────────────────────────────────────────────────────
(async () => {
  let browser;
  try {
    log(`Connecting to Chrome on port ${CDP_PORT}...`);
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${CDP_PORT}`,
      defaultViewport: { width: 1280, height: 800 },
    });

    const pages = await browser.pages();
    let page = pages.find(p => p.url().includes('youtube.com')) || pages[0];
    if (!page) page = await browser.newPage();

    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
    );

    await warmupScript(page);
  } catch (err) {
    console.error(`[yt-warmup | ${PROFILE_ID}] Fatal:`, err.message);
    process.exit(1);
  } finally {
    if (browser) await browser.disconnect().catch(() => {});
  }
})();
