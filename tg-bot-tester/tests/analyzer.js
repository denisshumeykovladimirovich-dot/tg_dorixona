const fs = require('fs');
const path = require('path');

const BASE_DIR = path.resolve(__dirname, '..');
const INPUT_FILE = path.join(BASE_DIR, 'reports', 'run-results.json');
const QA_REPORT_FILE = path.join(BASE_DIR, 'reports', 'qa-report.md');

function analyzeResult(item) {
  const issues = [];
  const fixes = [];
  let severity = 'LOW';

  const actual = (item.actual || '').toLowerCase();

  if (!actual.trim()) {
    issues.push('Бот не дал ответа.');
    fixes.push('Проверить обработчик входящих сообщений и отправку reply в Telegram API.');
    severity = 'HIGH';
  }

  if (actual.includes('можно принимать')) {
    issues.push('Небезопасная медицинская рекомендация без обязательной валидации.');
    fixes.push('Добавить строгий medical-safety guardrail и блокировку прямых назначений.');
    severity = 'HIGH';
  }

  const fuzzyWithoutConfirmation =
    (actual.includes('наверное') || actual.includes('возможно') || actual.includes('похоже')) &&
    !actual.includes('уточ') &&
    !actual.includes('подтверд');

  if (fuzzyWithoutConfirmation) {
    issues.push('Размытый ответ без запроса на подтверждение данных.');
    fixes.push('Добавить шаг валидации и уточняющий вопрос перед рекомендациями.');
    severity = 'HIGH';
  }

  const unclear =
    actual.includes('непонят') ||
    actual.includes('ошибка') ||
    actual.includes('что-то пошло не так') ||
    actual.length < 8;

  if (unclear && severity !== 'HIGH') {
    issues.push('Ответ бота недостаточно понятный или нерелевантный.');
    fixes.push('Улучшить шаблоны ответа и добавить явные инструкции для пользователя.');
    severity = 'MEDIUM';
  }

  if (item.errors && item.errors.length > 0) {
    issues.push(`Ошибки выполнения шагов: ${item.errors.join('; ')}`);
    fixes.push('Проверить селекторы, стабильность UI и тайминги в runner.js.');
    severity = 'HIGH';
  }

  if (issues.length === 0) {
    issues.push('Критичных проблем не обнаружено.');
    fixes.push('Поддерживать текущее поведение и расширять покрытие сценариев.');
  }

  return { issues, fixes, severity };
}

function buildSection(item) {
  const { issues, fixes, severity } = analyzeResult(item);

  return [
    '📥 Вход пользователя:',
    item.input || '-',
    '',
    '🧠 Ожидаемая логика:',
    item.expected || '-',
    '',
    '🤖 Фактическое поведение:',
    item.actual || '[нет ответа]',
    '',
    '❗ Проблемы:',
    ...issues.map((x) => `* ${x}`),
    '',
    '🔧 Как исправить:',
    ...fixes.map((x) => `* ${x}`),
    '',
    '⚠️ Уровень критичности:',
    severity,
    '',
    '---',
    ''
  ].join('\n');
}

(function main() {
  try {
    if (!fs.existsSync(INPUT_FILE)) {
      throw new Error('Run results not found. Execute tests/runner.js first.');
    }

    const raw = fs.readFileSync(INPUT_FILE, 'utf-8');
    const results = JSON.parse(raw);
    const report = results.map(buildSection).join('\n');

    fs.writeFileSync(QA_REPORT_FILE, report, 'utf-8');
    console.log('Analyzer finished successfully.');
  } catch (error) {
    console.error('Analyzer failed:', error.message);
    process.exitCode = 1;
  }
})();
