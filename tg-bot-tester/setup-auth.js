const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE_DIR = __dirname;
const AUTH_DIR = path.join(BASE_DIR, 'auth');
const AUTH_FILE = path.join(AUTH_DIR, 'auth.json');
const TELEGRAM_URL = 'https://web.telegram.org/a/#8299609674';
const LOGIN_WAIT_MS = Number(process.env.LOGIN_WAIT_MS || 90000);
const DEFAULT_COMET_PATH = path.join(
  process.env.LOCALAPPDATA || '',
  'Perplexity',
  'Comet',
  'Application',
  'comet.exe'
);
const BROWSER_PATH = process.env.COMET_BROWSER_PATH || DEFAULT_COMET_PATH;

function getLaunchOptions() {
  const options = { headless: false };
  if (BROWSER_PATH && fs.existsSync(BROWSER_PATH)) {
    options.executablePath = BROWSER_PATH;
    console.log(`Браузер: Comet (${BROWSER_PATH})`);
  } else {
    console.log('Браузер: Playwright Chromium (Comet не найден)');
  }
  return options;
}

(async () => {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const browser = await chromium.launch(getLaunchOptions());
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(TELEGRAM_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    console.log('Выполните вход вручную в открытом окне Telegram Web.');
    console.log(`Ожидание ${Math.round(LOGIN_WAIT_MS / 1000)} сек. Затем сессия сохранится автоматически.`);
    await page.waitForTimeout(LOGIN_WAIT_MS);

    await context.storageState({ path: AUTH_FILE });
    console.log('Сессия сохранена в auth/auth.json');
  } catch (error) {
    console.error('setup-auth failed:', error.message);
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
})();
