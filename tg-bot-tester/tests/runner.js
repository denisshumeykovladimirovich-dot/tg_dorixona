const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const TELEGRAM_URL = 'https://web.telegram.org/a/#8299609674';
const BASE_DIR = path.resolve(__dirname, '..');
const AUTH_FILE = path.join(BASE_DIR, 'auth', 'auth.json');
const REPORTS_DIR = path.join(BASE_DIR, 'reports');
const SCREENSHOTS_DIR = path.join(REPORTS_DIR, 'screenshots');
const REPORT_FILE = path.join(REPORTS_DIR, 'report.md');
const RESULTS_FILE = path.join(REPORTS_DIR, 'run-results.json');
const DEFAULT_COMET_PATH = path.join(
  process.env.LOCALAPPDATA || '',
  'Perplexity',
  'Comet',
  'Application',
  'comet.exe'
);
const BROWSER_PATH = process.env.COMET_BROWSER_PATH || DEFAULT_COMET_PATH;

function readScenarios() {
  const scenarioFile = path.join(__dirname, 'scenarios.js');
  delete require.cache[require.resolve(scenarioFile)];
  const scenarios = require(scenarioFile);
  if (!Array.isArray(scenarios)) {
    throw new Error('tests/scenarios.js must export an array');
  }
  return scenarios;
}

function ensureDirs() {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

function getLaunchOptions() {
  const options = { headless: false };
  if (BROWSER_PATH && fs.existsSync(BROWSER_PATH)) {
    options.executablePath = BROWSER_PATH;
    console.log(`Browser: Comet (${BROWSER_PATH})`);
  } else {
    console.log('Browser: Playwright Chromium (Comet not found)');
  }
  return options;
}

function safeFileName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '_')
    .replace(/^_+|_+$/g, '');
}

async function sendMessage(page, text) {
  const inputSelectors = [
    '[contenteditable="true"][data-testid="input-message-input"]',
    '.input-message-input[contenteditable="true"]',
    '.input-message-input',
    '[contenteditable="true"]'
  ];

  let input = null;
  for (const selector of inputSelectors) {
    const candidate = page.locator(selector).last();
    if (await candidate.isVisible().catch(() => false)) {
      input = candidate;
      break;
    }
  }

  if (!input) {
    for (const selector of inputSelectors) {
      const candidate = page.locator(selector).last();
      try {
        await candidate.waitFor({ state: 'visible', timeout: 6000 });
        input = candidate;
        break;
      } catch (_) {
        // try next selector
      }
    }
  }

  if (!input) {
    throw new Error('Telegram input not found');
  }

  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}

async function clickButton(page, buttonText) {
  const candidates = [
    page.locator('button', { hasText: buttonText }).first(),
    page.locator('[role="button"]', { hasText: buttonText }).first(),
    page.locator(`text=${buttonText}`).first()
  ];

  for (const locator of candidates) {
    if (await locator.isVisible().catch(() => false)) {
      await locator.click();
      return;
    }
  }

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: 'visible', timeout: 6000 });
      await locator.click();
      return;
    } catch (_) {
      // try next selector
    }
  }

  throw new Error(`Button not found: ${buttonText}`);
}

async function getLastBotResponse(page) {
  try {
    const selectors = ['div.message', 'div.Message', '.message', '.Message'];

    for (const selector of selectors) {
      const messages = page.locator(selector);
      const count = await messages.count();
      if (count === 0) {
        continue;
      }

      const start = Math.max(0, count - 15);
      for (let i = count - 1; i >= start; i -= 1) {
        const msg = messages.nth(i);
        const isOutgoing =
          (await msg.locator('.is-out').count().catch(() => 0)) > 0 ||
          (await msg.locator('.own, .outgoing').count().catch(() => 0)) > 0;
        if (isOutgoing) {
          continue;
        }

        const text = (await msg.innerText().catch(() => '')).trim();
        if (text) {
          return text;
        }
      }
    }

    return await page.evaluate(() => {
      const hasLetter = (text) => /\p{L}/u.test(text);
      const candidates = Array.from(document.querySelectorAll('[dir="auto"], .text-content, [class*="text"]'))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
          return { text, x: rect.x, y: rect.y, w: rect.width };
        })
        .filter((item) => {
          if (!item.text || item.text.length < 8 || !hasLetter(item.text)) {
            return false;
          }
          if (item.w < 120) {
            return false;
          }
          if (item.x < window.innerWidth * 0.2 || item.x > window.innerWidth * 0.8) {
            return false;
          }
          if (item.y < 70 || item.y > window.innerHeight - 70) {
            return false;
          }
          return true;
        })
        .sort((a, b) => b.y - a.y);

      return candidates[0]?.text || '';
    });
  } catch (error) {
    return '';
  }
}

async function runScenario(page, scenario) {
  const inputLog = [];
  const stepErrors = [];

  for (const step of scenario.steps) {
    try {
      if (step.type === 'send') {
        inputLog.push(step.text);
        await sendMessage(page, step.text);
      } else if (step.type === 'click') {
        await clickButton(page, step.text);
      } else {
        stepErrors.push(`Unknown step type: ${step.type}`);
      }

      await page.waitForTimeout(step.waitMs || 2200);
    } catch (error) {
      stepErrors.push(`Step failed (${step.type}): ${error.message}`);
      await page.waitForTimeout(1000);
    }
  }

  const botResponse = await getLastBotResponse(page);
  const normalizedActual = (botResponse || '').toLowerCase();
  const expectedIncludes = Array.isArray(scenario.expectIncludes) ? scenario.expectIncludes : [];
  const missingExpectations = expectedIncludes.filter(
    (token) => !normalizedActual.includes(String(token).toLowerCase())
  );
  if (missingExpectations.length > 0) {
    stepErrors.push(`Expected tokens not found in bot response: ${missingExpectations.join(', ')}`);
  }

  return {
    input: inputLog.join(' | '),
    expected: scenario.expected,
    actual: botResponse,
    errors: stepErrors,
    status: stepErrors.length > 0 ? 'FAILED' : 'OK'
  };
}

function writeMarkdownReport(items) {
  let md = '# QA REPORT\n\n';
  for (const item of items) {
    md += `## Scenario: ${item.name}\n\n`;
    md += `* Status: ${item.status}\n`;
    md += `* Screenshot: ${item.screenshot}\n\n`;
  }

  fs.writeFileSync(REPORT_FILE, md, 'utf-8');
}

(async () => {
  ensureDirs();

  if (!fs.existsSync(AUTH_FILE)) {
    throw new Error('Auth file not found. Run: node setup-auth.js');
  }

  const scenarios = readScenarios();
  const browser = await chromium.launch(getLaunchOptions());
  const context = await browser.newContext({ storageState: AUTH_FILE });
  const page = await context.newPage();

  const reportItems = [];
  const detailedResults = [];

  try {
    await page.goto(TELEGRAM_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3500);

    for (const scenario of scenarios) {
      const scenarioResult = await runScenario(page, scenario);

      const screenshotName = `${safeFileName(scenario.name) || 'scenario'}.png`;
      const screenshotPath = path.join(SCREENSHOTS_DIR, screenshotName);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      reportItems.push({
        name: scenario.name,
        status: scenarioResult.status,
        screenshot: `reports/screenshots/${screenshotName}`
      });

      detailedResults.push({
        name: scenario.name,
        ...scenarioResult,
        screenshot: `reports/screenshots/${screenshotName}`
      });

      await page.waitForTimeout(1200);
    }

    writeMarkdownReport(reportItems);
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(detailedResults, null, 2), 'utf-8');

    console.log('Runner finished successfully.');
  } catch (error) {
    console.error('Runner failed:', error.message);
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
})();
