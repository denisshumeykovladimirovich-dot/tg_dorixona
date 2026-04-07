const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const TELEGRAM_URL = "https://web.telegram.org/a/#8299609674";
const BASE_DIR = path.resolve(__dirname, "..");
const AUTH_FILE = path.join(BASE_DIR, "auth", "auth.json");
const REPORTS_DIR = path.join(BASE_DIR, "reports");
const OUTPUT_FILE = path.join(REPORTS_DIR, "forensic-results.json");
const DEFAULT_COMET_PATH = path.join(
  process.env.LOCALAPPDATA || "",
  "Perplexity",
  "Comet",
  "Application",
  "comet.exe"
);
const BROWSER_PATH = process.env.COMET_BROWSER_PATH || DEFAULT_COMET_PATH;

const T = {
  START: "/start",
  CHECK: "\u041f\u0440\u043e\u0432\u0435\u0440\u0438\u0442\u044c \u043b\u0435\u043a\u0430\u0440\u0441\u0442\u0432\u0430",
  AGE_0_5: "0\u20135",
  AGE_5_10: "5\u201310",
  AGE_10_15: "10\u201315",
  AGE_15_60: "15\u201360",
  AGE_60_PLUS: "60+",
  AGE_EXACT: "\u0412\u0432\u0435\u0441\u0442\u0438 \u0442\u043e\u0447\u043d\u043e",
  COUGH: "\u041a\u0430\u0448\u0435\u043b\u044c",
  FEVER: "\u0422\u0435\u043c\u043f\u0435\u0440\u0430\u0442\u0443\u0440\u0430",
  THROAT: "\u0413\u043e\u0440\u043b\u043e",
  RUNNY: "\u041d\u0430\u0441\u043c\u043e\u0440\u043a",
  PAIN: "\u0411\u043e\u043b\u044c",
  ALLERGY: "\u0410\u043b\u043b\u0435\u0440\u0433\u0438\u044f",
  OTHER: "\u0414\u0440\u0443\u0433\u043e\u0435",
  WET_COUGH: "\u0412\u043b\u0430\u0436\u043d\u044b\u0439 \u043a\u0430\u0448\u0435\u043b\u044c",
  MANUAL_INPUT: "\u0412\u0432\u0435\u0441\u0442\u0438 \u0432\u0440\u0443\u0447\u043d\u0443\u044e",
  ADD_MORE: "\u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u0435\u0449\u0451 \u043f\u0440\u0435\u043f\u0430\u0440\u0430\u0442",
  CHECK_COMBO: "\u041f\u0440\u043e\u0432\u0435\u0440\u0438\u0442\u044c \u0441\u043e\u0447\u0435\u0442\u0430\u043d\u0438\u0435",
  ADD_MORE_MANUAL: "\u0412\u0432\u0435\u0441\u0442\u0438 \u0432\u0440\u0443\u0447\u043d\u0443\u044e",
  ADD_MORE_SYMPTOM: "\u0412\u044b\u0431\u0440\u0430\u0442\u044c \u043f\u043e \u0441\u0438\u043c\u043f\u0442\u043e\u043c\u0443",
  BACK: "\u041d\u0430\u0437\u0430\u0434"
};

const SCENARIOS = [
  {
    id: "A1",
    name: "Symptom flow 0-5 -> Cough -> Wet cough",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_0_5 },
      { type: "click", text: T.COUGH },
      { type: "click", text: T.WET_COUGH }
    ],
    includeAny: ["\u0421\u043f\u0440\u0430\u0432\u043e\u0447\u043d\u0430\u044f \u043f\u043e\u0434\u0431\u043e\u0440\u043a\u0430", "\u0412\u0432\u0435\u0441\u0442\u0438 \u0432\u0440\u0443\u0447\u043d\u0443\u044e"]
  },
  {
    id: "A2_B1",
    name: "Ambroxol card then single-drug check combination",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_0_5 },
      { type: "click", text: T.COUGH },
      { type: "click", text: T.WET_COUGH },
      { type: "click", text: "Ambroxol" },
      { type: "click", text: T.CHECK_COMBO }
    ]
  },
  {
    id: "A3_ru",
    name: "Manual input: Амброксол",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_0_5 },
      { type: "click", text: T.COUGH },
      { type: "click", text: T.WET_COUGH },
      { type: "click", text: T.MANUAL_INPUT },
      { type: "send", text: "\u0410\u043c\u0431\u0440\u043e\u043a\u0441\u043e\u043b" }
    ]
  },
  {
    id: "A3_en",
    name: "Manual input: Ambroxol",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_0_5 },
      { type: "click", text: T.COUGH },
      { type: "click", text: T.WET_COUGH },
      { type: "click", text: T.MANUAL_INPUT },
      { type: "send", text: "Ambroxol" }
    ]
  },
  {
    id: "A4_fever",
    name: "Category: Temperature",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_5_10 },
      { type: "click", text: T.FEVER }
    ]
  },
  {
    id: "A4_throat",
    name: "Category: Throat",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_5_10 },
      { type: "click", text: T.THROAT }
    ]
  },
  {
    id: "A4_runny",
    name: "Category: Runny nose",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_5_10 },
      { type: "click", text: T.RUNNY }
    ]
  },
  {
    id: "A4_pain",
    name: "Category: Pain",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_5_10 },
      { type: "click", text: T.PAIN }
    ]
  },
  {
    id: "A4_allergy",
    name: "Category: Allergy",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_5_10 },
      { type: "click", text: T.ALLERGY }
    ]
  },
  {
    id: "A4_other",
    name: "Category: Other",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_5_10 },
      { type: "click", text: T.OTHER }
    ]
  },
  {
    id: "B2_single5",
    name: "Single-drug check for 5 meds",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_15_60 },
      { type: "click", text: T.MANUAL_INPUT },
      { type: "send", text: "\u0430\u043c\u0431\u0440\u043e\u043a\u0441\u043e\u043b" },
      { type: "send", text: "\u0438\u0431\u0443\u043f\u0440\u043e\u0444\u0435\u043d" },
      { type: "send", text: "\u043f\u0430\u0440\u0430\u0446\u0435\u0442\u0430\u043c\u043e\u043b" },
      { type: "send", text: "\u043b\u043e\u0440\u0430\u0442\u0430\u0434\u0438\u043d" },
      { type: "send", text: "\u043e\u043c\u0435\u043f\u0440\u0430\u0437\u043e\u043b" }
    ]
  },
  {
    id: "C1",
    name: "Two-drug normal combination via add more",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_10_15 },
      { type: "click", text: T.MANUAL_INPUT },
      { type: "send", text: "\u043f\u0430\u0440\u0430\u0446\u0435\u0442\u0430\u043c\u043e\u043b" },
      { type: "click", text: T.ADD_MORE },
      { type: "click", text: T.ADD_MORE_MANUAL },
      { type: "send", text: "\u0438\u0431\u0443\u043f\u0440\u043e\u0444\u0435\u043d" },
      { type: "send", text: "2 \u043f\u0440\u0435\u043f\u0430\u0440\u0430\u0442\u0430" }
    ]
  },
  {
    id: "C2_dup",
    name: "Duplicate same drug twice",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_15_60 },
      { type: "click", text: T.MANUAL_INPUT },
      { type: "send", text: "\u0430\u043c\u0431\u0440\u043e\u043a\u0441\u043e\u043b, \u0430\u043c\u0431\u0440\u043e\u043a\u0441\u043e\u043b" }
    ]
  },
  {
    id: "C3_alias_dup",
    name: "RU + EN alias duplicate",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_15_60 },
      { type: "click", text: T.MANUAL_INPUT },
      { type: "send", text: "\u0430\u043c\u0431\u0440\u043e\u043a\u0441\u043e\u043b, Ambroxol" }
    ]
  },
  {
    id: "D1_partial",
    name: "Partial manual inputs",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_15_60 },
      { type: "click", text: T.MANUAL_INPUT },
      { type: "send", text: "\u0430\u043c\u0431\u0440" },
      { type: "send", text: "\u043f\u0430\u0440\u0430\u0446" },
      { type: "send", text: "\u043d\u0443\u0440\u043e" },
      { type: "send", text: "\u0438\u0431\u0443\u043f" },
      { type: "send", text: "\u0441\u0443\u043f\u0440" }
    ]
  },
  {
    id: "D3_dosage",
    name: "Manual input with dosage",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_15_60 },
      { type: "click", text: T.MANUAL_INPUT },
      { type: "send", text: "\u0430\u043c\u0431\u0440\u043e\u043a\u0441\u043e\u043b 30 \u043c\u0433, \u0438\u0431\u0443\u043f\u0440\u043e\u0444\u0435\u043d 200 \u043c\u0433" }
    ]
  },
  {
    id: "D4_two_inline",
    name: "Two drugs in one line",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_15_60 },
      { type: "click", text: T.MANUAL_INPUT },
      { type: "send", text: "ambroxol ibuprofen" }
    ]
  },
  {
    id: "D5_noisy",
    name: "Noisy natural language",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_0_5 },
      { type: "click", text: T.MANUAL_INPUT },
      { type: "send", text: "\u0440\u0435\u0431\u0451\u043d\u043a\u0443 3 \u0433\u043e\u0434\u0430 \u0430\u043c\u0431\u0440\u043e\u043a\u0441\u043e\u043b" }
    ]
  },
  {
    id: "E2_exact_age",
    name: "Exact age entry 5 years text",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_EXACT },
      { type: "send", text: "5 \u043b\u0435\u0442" }
    ]
  },
  {
    id: "F2_restart",
    name: "New /start should reset state",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_0_5 },
      { type: "click", text: T.COUGH },
      { type: "send", text: T.START }
    ]
  },
  {
    id: "F4_multiclick",
    name: "Repeated click on same age button",
    steps: [
      { type: "send", text: T.START },
      { type: "click", text: T.CHECK },
      { type: "click", text: T.AGE_0_5 },
      { type: "click", text: T.AGE_0_5 },
      { type: "click", text: T.AGE_0_5 }
    ]
  }
];

function ensureDirs() {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function getLaunchOptions() {
  const options = { headless: false };
  if (BROWSER_PATH && fs.existsSync(BROWSER_PATH)) {
    options.executablePath = BROWSER_PATH;
  }
  return options;
}

async function findVisibleLocator(page, text) {
  const variants = Array.from(
    new Set(
      [
        text,
        String(text || "").replace(/\u2013/g, "-"),
        String(text || "").replace(/-/g, "\u2013"),
        String(text || "").replace(/\s+/g, " ").trim()
      ].filter(Boolean)
    )
  );

  if (String(text) === T.AGE_0_5 || String(text) === "0-5") {
    variants.push("0-5", "0\u20135", "0 — 5", "0 – 5");
  }

  if (String(text) === T.AGE_5_10 || String(text) === "5-10") {
    variants.push("5-10", "5\u201310", "5 – 10");
  }

  const candidates = [
    ...variants.map((v) => page.locator("button", { hasText: v })),
    ...variants.map((v) => page.locator("[role='button']", { hasText: v })),
    ...variants.map((v) => page.locator(`text=${v}`))
  ];

  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i -= 1) {
      const el = locator.nth(i);
      if (await el.isVisible().catch(() => false)) {
        return el;
      }
    }
  }

  return null;
}

async function clickByText(page, text) {
  const locator = await findVisibleLocator(page, text);
  if (!locator) {
    throw new Error(`Button/text not found: ${text}`);
  }
  await locator.click({ timeout: 7000 });
}

async function sendMessage(page, text) {
  const selectors = [
    '[contenteditable="true"][data-testid="input-message-input"]',
    ".input-message-input[contenteditable='true']",
    ".input-message-input",
    '[contenteditable="true"]'
  ];

  let input = null;
  for (const selector of selectors) {
    const locator = page.locator(selector).last();
    if (await locator.isVisible().catch(() => false)) {
      input = locator;
      break;
    }
  }

  if (!input) {
    throw new Error("Telegram input not found");
  }

  await input.click();
  await input.fill(text);
  await page.keyboard.press("Enter");
}

async function getIncomingMessages(page) {
  return await page.evaluate(() => {
    const chunks = [];
    const layout = document.querySelector(".messages-layout");
    if (layout && layout.innerText) {
      chunks.push(layout.innerText);
    }
    const transition = document.querySelector(".MessageList");
    if (transition && transition.innerText) {
      chunks.push(transition.innerText);
    }
    const body = document.body?.innerText || "";
    if (body) {
      chunks.push(body);
    }
    return chunks
      .join("\n\n")
      .split(/\n{2,}/)
      .map((x) => x.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  });
}

async function runScenario(page, scenario) {
  const startedAt = new Date().toISOString();
  const before = await getIncomingMessages(page);
  const stepLogs = [];
  const errors = [];

  for (const step of scenario.steps) {
    try {
      if (step.type === "send") {
        await sendMessage(page, step.text);
        stepLogs.push(`send: ${step.text}`);
      } else if (step.type === "click") {
        await clickByText(page, step.text);
        stepLogs.push(`click: ${step.text}`);
      } else {
        throw new Error(`Unknown step: ${step.type}`);
      }
      await page.waitForTimeout(step.waitMs || 2600);
    } catch (error) {
      errors.push(`${step.type} ${step.text || ""} -> ${error.message}`);
      await page.waitForTimeout(1200);
    }
  }

  await page.waitForTimeout(1800);
  const after = await getIncomingMessages(page);
  const newMessages = after.slice(before.length);
  const combined = newMessages.join("\n\n");
  const normalized = combined.toLowerCase();

  const missingIncludes = (scenario.includeAny || []).length
    ? (scenario.includeAny || []).every((token) => !normalized.includes(String(token).toLowerCase()))
      ? scenario.includeAny
      : []
    : [];

  const foundExcludes = (scenario.exclude || []).filter((token) =>
    normalized.includes(String(token).toLowerCase())
  );

  return {
    id: scenario.id,
    name: scenario.name,
    startedAt,
    steps: stepLogs,
    errors,
    newMessages,
    combined,
    checks: {
      missingIncludes,
      foundExcludes
    },
    status: errors.length === 0 && missingIncludes.length === 0 && foundExcludes.length === 0 ? "OK" : "ISSUE"
  };
}

(async () => {
  ensureDirs();
  if (!fs.existsSync(AUTH_FILE)) {
    throw new Error("Auth file not found. Run setup-auth.js");
  }

  const browser = await chromium.launch(getLaunchOptions());
  const context = await browser.newContext({ storageState: AUTH_FILE });
  const page = await context.newPage();
  const results = [];

  try {
    await page.goto(TELEGRAM_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(5000);

    for (const scenario of SCENARIOS) {
      const result = await runScenario(page, scenario);
      results.push(result);
      await page.waitForTimeout(1200);
    }
  } finally {
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2), "utf-8");
    await context.close();
    await browser.close();
  }
})();
