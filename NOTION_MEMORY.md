# Notion Memory

## Bug Log
| id | шаг | описание | статус | фикс |
|---|---|---|---|---|
| BUG-001 | symptom detail callback | `callback_data` был длиннее 64 байт и ломал flow | fixed | `symdet_<cat>_<index>` вместо URL-encoded текста |
| BUG-002 | UI текст | Кракозябры в названиях/описаниях | in_progress | Усилено runtime-декодирование (`cleanAndDecode`, cp1251 fallback) |
| BUG-003 | product flow | После symptom-flow терялась core value проверки сочетаний | fixed | Добавлены `➕ Добавить ещё`, `🔎 Проверить сочетание`, возврат к анализу |

## QA Scenarios
| сценарий | вход | ожидание | факт |
|---|---|---|---|
| Кашель -> препараты | Категория: Кашель, деталь: Сухой кашель | Появляется до 5 препаратов из локальной базы | pending |
| Выбор препарата кнопкой | `drug_select_<id>` | Открывается карточка препарата с кнопкой покупки | pending |
| Поиск "анзибел" | Ввод: `анзибел` | Находит локальный препарат по aliases | pending |
| Кнопка Купить | `buy_drug_<id>` | Появляется ссылка `https://apteka.uz/search?...` | pending |
| outbound_click | Нажатие "💊 Купить в аптеке" | В логах есть `outbound_click` с userId/drugId/drugName/timestamp | pending |
| Symptom -> Add more -> Check | Симптом -> препарат -> "Добавить ещё" -> второй препарат | Возврат к итоговому блоку риска/причины/действий | pending |

## Growth Log
| дата | что внедрили | гипотеза | метрика |
|---|---|---|---|
| 2026-03-31 | Симптом -> препарат -> купить (apteka.uz UTM) | Сокращение шагов увеличит CTR на аптечный переход | CTR кнопки покупки, outbound_click count |
| 2026-03-31 | Вернули core analysis + кнопочный UX | Пользователь чаще доходит до полезного результата и потом кликает в аптеку | completion rate до анализа, CTR buy после анализа |

## Event Logging Notes
| событие | когда пишем | ключевые поля |
|---|---|---|
| `message_input_received` | любое текстовое сообщение | `userId`, `chatId`, `currentStep`, `rawInput` |
| `callback_received` | любое нажатие inline | `callbackData`, `callbackDataLength`, `currentStep` |
| `age_selected`, `age_entered_exact` | возрастные шаги | `selectedAge`, `ageBucket` |
| `symptom_category_selected`, `symptom_detail_selected`, `symptom_manual_entered` | шаги симптомов | `selectedSymptomCategory`, `selectedSymptom` |
| `symptom_matches_found/empty`, `drug_suggestion_shown` | подбор из локальной базы | `normalizedInput`, `suggestedNames` |
| `drug_selected`, `drug_lookup_success/fail` | выбор/поиск препарата | `selectedDrugId`, `selectedDrugName`, `resultSummary` |
| `add_another_drug_clicked`, `combination_check_started/completed` | core value сценарий | `draftSnapshot`, `status`, `medsCount` |
| `buy_clicked` | клик по покупке | `drugId`, `drugName` |
| `back_clicked`, `callback_error`, `flow_error`, `state_reset` | отладка flow | `errorMessage`, `reason`, `currentStep` |

## Deals Pipeline
| аптека | контакт | статус | предложение |
|---|---|---|---|
| apteka.uz |  | discovery | CPC/CPA за переходы по UTM + бренд-приоритет в выдаче |
