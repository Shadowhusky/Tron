/**
 * Capture a screenshot of the Web Server settings panel in Electron.
 * Usage: node scripts/capture-web-server-screenshot.mjs
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
  await page.reload();
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15000 });
  await sleep(2000);

  // Force-remove the wizard if it persists (config file race condition)
  for (let attempt = 0; attempt < 3; attempt++) {
    const wizardVisible = await page.locator('[data-testid="onboarding-wizard"]')
      .isVisible({ timeout: 1000 }).catch(() => false);
    if (!wizardVisible) break;

    console.log(`  Dismissing onboarding wizard (attempt ${attempt + 1})...`);
    await page.evaluate(() => {
      localStorage.setItem('tron_configured', 'true');
      localStorage.setItem('tron_tutorial_completed', 'true');
      const wiz = document.querySelector('[data-testid="onboarding-wizard"]');
      if (wiz) wiz.remove();
    });
    await sleep(500);
  }

  // If config file wrote over our values, also try IPC write
  const wizardStillVisible = await page.locator('[data-testid="onboarding-wizard"]')
    .isVisible({ timeout: 500 }).catch(() => false);
  if (wizardStillVisible) {
    console.log('  Attempting IPC config write...');
    await page.evaluate(async () => {
      await window.electron?.ipcRenderer?.writeConfig?.({
        configured: true,
        tutorialCompleted: true,
        theme: 'dark',
        viewMode: 'terminal',
      });
    });
    await page.reload();
    await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15000 });
    await sleep(2000);
  }
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
  await page.waitForLoadState('domcontentloaded');

  // Dismiss onboarding
  await dismissOnboarding(page);

  // Open settings
  console.log('Opening settings...');
  await page.click('[data-testid="tab-settings"]');
  await page.waitForSelector('[data-testid="settings-pane"]', { timeout: 5000 });
  await sleep(500);

  // Navigate to Web Server section
  console.log('Navigating to Web Server...');
  await page.click('[data-testid="settings-nav-web-server"]');
  await sleep(1000);

  // Take screenshot
  const screenshotPath = path.resolve(__dirname, '../screenshots/demo-web-server.png');
  await page.screenshot({ path: screenshotPath });
  console.log(`Screenshot saved: ${screenshotPath}`);

  // Also copy to website demos
  const websitePath = path.resolve(__dirname, '../../tron-website/public/demos/demo-web-server.png');
  fs.copyFileSync(screenshotPath, websitePath);
  console.log(`Copied to: ${websitePath}`);

  await app.close();
  console.log('Done!');

  // Cleanup profile dir
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
}

main().catch(e => {
  console.error('Failed:', e);
  process.exit(1);
});
