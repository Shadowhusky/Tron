/**
 * Capture a hero screenshot of Tron's desktop app.
 * Usage: node scripts/capture-hero-screenshot.mjs
 */
import { _electron } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = path.resolve(__dirname, '../dist-electron/main.js');
const PROFILE_DIR = path.resolve(__dirname, `../.screenshots-profile-${Date.now()}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dismissOnboarding(page) {
  await page.evaluate(() => {
    localStorage.setItem('tron_configured', 'true');
    localStorage.setItem('tron_tutorial_completed', 'true');
    localStorage.setItem('tron_theme', 'dark');
    localStorage.setItem('tron_view_mode', 'terminal');
  });

  // Use ?skip-setup=true URL param to bypass onboarding wizard entirely
  const url = page.url().split('?')[0];
  await page.goto(`${url}?skip-setup=true`);
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15000 });
  await sleep(2000);
}

function setInput(page, val) {
  return page.evaluate((val) => {
    const all = document.querySelectorAll('[data-testid="smart-input-textarea"]');
    let el = null;
    for (const t of all) {
      if (getComputedStyle(t).visibility !== 'hidden') { el = t; break; }
    }
    if (!el && all.length > 0) el = all[all.length - 1];
    if (!el) return;
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;
    setter?.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, val);
}

function submitInput(page) {
  return page.evaluate(() => {
    const all = document.querySelectorAll('[data-testid="smart-input-textarea"]');
    let el = null;
    for (const t of all) {
      if (getComputedStyle(t).visibility !== 'hidden') { el = t; break; }
    }
    if (!el && all.length > 0) el = all[all.length - 1];
    if (!el) return;
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    }));
  });
}

async function main() {
  console.log('Launching Electron...');
  const app = await _electron.launch({
    args: [MAIN_JS],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TRON_TEST_PROFILE: PROFILE_DIR,
    },
  });

  const page = await app.firstWindow();

  // Resize window to a nice hero size
  console.log('Resizing window...');
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.setSize(1600, 1000);
      win.center();
    }
  });
  await sleep(1000);

  await page.waitForLoadState('domcontentloaded');
  await dismissOnboarding(page);

  // Wait for terminal
  console.log('Waiting for terminal...');
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const hasTerminal = await page.evaluate(() => {
      return !!(document.querySelector('.xterm-screen') || document.querySelector('canvas'));
    });
    if (hasTerminal) break;
    await sleep(500);
  }
  await sleep(3000);

  // Run several commands to fill the terminal nicely
  console.log('Running commands...');
  const commands = [
    "echo '  Tron v1.2.0 — AI-Powered Terminal'",
    "uname -a",
    "cd /Users/richardliao/Documents/Projects/tron && git log --oneline -8",
    "ls -la src/",
  ];

  for (const cmd of commands) {
    await setInput(page, cmd);
    await sleep(200);
    await submitInput(page);
    await sleep(2500);
  }

  // Leave a ghost-text worthy prompt in the input
  await setInput(page, 'git status');
  await sleep(500);

  // Take screenshot
  const screenshotPath = path.resolve(__dirname, '../screenshots/desktop-hero.png');
  await page.screenshot({ path: screenshotPath });
  console.log(`Screenshot saved: ${screenshotPath}`);

  await app.close();
  console.log('Done!');

  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
}

main().catch(e => {
  console.error('Failed:', e);
  process.exit(1);
});
