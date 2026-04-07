# tg_dorixona

## Запуск

1. Убедись, что в `.env` заполнены:
   - BOT_TOKEN
   - BOT_USERNAME

2. Установи зависимости:
   npm install

3. Запусти:
   npm run dev

## Что умеет MVP

- /start
- ввод лекарств через запятую
- rule-based анализ
- понятное объяснение
- семейная карточка
- deep link вида /start card_<id>
- shared purchase mode
- история
- напоминания (демо)

## Analytics Dashboard (demo / sales asset)

Локальный demo-дэшборд для показа бизнесу:
- трафик и активность
- воронка до перехода в аптеку
- топ симптомов/препаратов
- повторные визиты
- потенциал для аптек и фарм-компаний

### 1) Запуск API аналитики

Из корня проекта:

```bash
npm run analytics:build
npm run analytics:api
```

API стартует на `http://localhost:4010`.

### 2) Запуск dashboard UI

```bash
cd analytics-dashboard
npm install
npm run dev
```

UI стартует на `http://localhost:4173`.

### Источник данных

- Real data: `data/live_interactions.log` + `data/analytics-events.jsonl`
- Demo seed: автогенерируется через API при нехватке реальных событий

### Подключение реальных событий бота

Используй `logAnalyticsEvent(...)` из:

- `src/analytics/logger.ts`

и/или автоматическое зеркалирование текущих bot-событий через:

- `src/analytics/botEventAdapter.ts`
