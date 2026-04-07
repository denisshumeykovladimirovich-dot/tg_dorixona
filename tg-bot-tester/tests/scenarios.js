function hhmmNowPlus(minutesToAdd = 0) {
  const now = new Date(Date.now() + minutesToAdd * 60 * 1000);
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

const dueNow = hhmmNowPlus(0);

module.exports = [
  {
    name: 'Reminder quick mode + duplicate warning',
    expected: 'создание quick reminder и предупреждение о дубликате',
    expectIncludes: ['активное напоминание для этого препарата'],
    steps: [
      { type: 'send', text: '/start' },
      { type: 'send', text: '⏰ Мои напоминания' },
      { type: 'click', text: '➕ Добавить напоминание' },
      { type: 'click', text: '✅ Понятно', waitMs: 2000 },
      { type: 'send', text: 'Парацетамол' },
      { type: 'click', text: '⚡ Быстрое напоминание' },
      { type: 'send', text: '08:00' },
      { type: 'click', text: '1 раз в день' },
      { type: 'click', text: '3 дня' },
      { type: 'click', text: '✅ Сохранить' },
      { type: 'click', text: '➕ Добавить напоминание' },
      { type: 'send', text: 'Парацетамол' },
      { type: 'click', text: '⚡ Быстрое напоминание' },
      { type: 'send', text: '09:00' },
      { type: 'click', text: '1 раз в день' },
      { type: 'click', text: '3 дня' },
      { type: 'click', text: '✅ Сохранить' }
    ]
  },
  {
    name: 'Reminder advanced mode + interaction warning + save anyway',
    expected: 'создание advanced reminder и warning для риска сочетаний',
    expectIncludes: ['возможном риске сочетания', 'сохранено с предупреждением'],
    steps: [
      { type: 'send', text: '⏰ Мои напоминания' },
      { type: 'click', text: '➕ Добавить напоминание' },
      { type: 'send', text: 'Ибупрофен' },
      { type: 'click', text: '⚙️ Расширенный режим' },
      { type: 'send', text: '1 таблетка' },
      { type: 'send', text: 'после еды' },
      { type: 'send', text: '08:30' },
      { type: 'click', text: '2 раза в день' },
      { type: 'click', text: '5 дней' },
      { type: 'click', text: '✅ Сохранить' },
      { type: 'click', text: 'Всё равно сохранить' }
    ]
  },
  {
    name: 'Reminder settings + quiet hours + history/stats',
    expected: 'настройки уведомлений и quiet hours доступны, stats доступны',
    expectIncludes: ['тихие часы', 'последние события'],
    steps: [
      { type: 'send', text: '⏰ Мои напоминания' },
      { type: 'click', text: '⚙️ Настройки уведомлений' },
      { type: 'click', text: '🌙 Тихие часы вкл' },
      { type: 'click', text: '🕒 Время тихих часов' },
      { type: 'send', text: '23:00-07:00' },
      { type: 'click', text: '◀️ Назад' },
      { type: 'click', text: '📊 Моя история приёма' }
    ]
  },
  {
    name: 'Reminder course actions open pause finish delete',
    expected: 'карточка курса открывается и управляется кнопками',
    expectIncludes: ['удалено'],
    steps: [
      { type: 'send', text: '⏰ Мои напоминания' },
      { type: 'click', text: '📋 Активные курсы' },
      { type: 'click', text: 'Открыть' },
      { type: 'click', text: '⏸ Пауза' },
      { type: 'click', text: '◀️ Назад' },
      { type: 'click', text: '📋 Активные курсы' },
      { type: 'click', text: 'Завершить' },
      { type: 'click', text: '📋 Активные курсы' },
      { type: 'click', text: 'Открыть' },
      { type: 'click', text: '🗑 Удалить' }
    ]
  },
  {
    name: 'Live notification delivery + taken/skip/snooze callbacks',
    expected: 'реальное уведомление приходит и callback-кнопки работают',
    expectIncludes: ['приём отмечен'],
    steps: [
      { type: 'send', text: '⏰ Мои напоминания' },
      { type: 'click', text: '➕ Добавить напоминание' },
      { type: 'send', text: 'Амброксол' },
      { type: 'click', text: '⚡ Быстрое напоминание' },
      { type: 'send', text: dueNow },
      { type: 'click', text: '1 раз в день' },
      { type: 'click', text: '1 день' },
      { type: 'click', text: '✅ Сохранить' },
      { type: 'send', text: '⏰ Мои напоминания', waitMs: 305000 },
      { type: 'click', text: '⏳ Отложить', waitMs: 2000 },
      { type: 'click', text: '15 минут', waitMs: 2200 },
      { type: 'click', text: '✅ Отметить как принято', waitMs: 2200 },
      { type: 'click', text: '❌ Пропустить', waitMs: 2200 }
    ]
  }
];
