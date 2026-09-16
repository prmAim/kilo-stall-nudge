# kilo-stall-nudge

Стоп-гэп Kilo-плагин: детектирует «замирание» агентной сессии (пустой финальный ход после результата инструмента либо тишину дольше таймаута) и автоматически пинает цикл синтетическим сообщением «продолжай», с ограничением числа пинков и alert-режимом.

> Временное решение. Upstream чинит эту проблему в CLI (Kilo-Org/kilocode [#12208](https://github.com/Kilo-Org/kilocode/issues/12208), [#12209](https://github.com/Kilo-Org/kilocode/issues/12209)). После выхода фикса удали этот плагин.

## Установка

Один из способов подключения через `kilo.json`. Опции плагина передаются **вторым элементом tuple** в массиве `plugin`:

```jsonc
{
  "plugin": [["file:///C:/Git/kilo-stall-nudge/plugin.js", { "enabled": true }]]
}
```

Либо npm-пакетом (если опубликован):

```jsonc
{
  "plugin": [["kilo-stall-nudge", { "enabled": true }]]
}
```

Либо файлом в каталоге плагинов (`{project}/.kilo/plugin/` или `~/.config/kilo/plugin/`) — тогда опции задать негде, дефолт `enabled: false`, так что для включения используй `file://`+tuple выше.

## Опции плагина (второй элемент tuple)

| Поле | Дефолт | Описание |
| --- | --- | --- |
| `enabled` | `false` | Плагин выключен, пока явно не включён |
| `stateDir` | `.scratch` | Каталог с `status.txt` и `plugin.log` |
| `idleTimeoutMs` | `180000` | Таймаут тишины до детекта «зависшего хода» |
| `maxNudges` | `3` | Максимум пинков в одном эпизоде замирания |
| `onStall` | `nudge` | `nudge` \| `alert` \| `both` |
| `nudgePrompt` | … | Промпт, отправляемый при пинке |

## Как это работает

- **armed** ← результат инструмента (`tool.execute.after`); стартует таймер `idleTimeoutMs`.
- **disarmed** ← вывод модели (текст или tool-call).
- **stalled** ← одно из двух из состояния armed: (A) ход завершился пустым финальным сообщением; (B) таймер истёк без вывода.
- Пинок = синтетический user-месседж через `client.session.prompt` с текстом `nudgePrompt`.
- Счётчик пинков растёт на каждый пинок без вывода модели; сбрасывается при выводе. После `maxNudges` — только alert.
- При `.scratch/status.txt == DONE` пинков нет никогда.
- При наличии маркера `WAITING_FOR_HUMAN` в `<stateDir>/state.md` пинков нет (fail-closed: пока человек явно не снимет маркер).

Логирование — в `<stateDir>/plugin.log`, формат: `[ts] STALL detected (age=Xs) → nudge #n`.

## Требования к state-файлам

Плагин читает `<stateDir>/status.txt` (гейт DONE) и `<stateDir>/state.md` (гейт WAITING_FOR_HUMAN — подстрока в любом месте файла). Содержимое `worklog.md` читает сама модель по промпту пинка.

## Разработка

```bash
npm test   # node --test
```

## Ограничения

- Сигнал «ход завершился» — событие `session.idle` (в схеме Kilo помечено deprecated в пользу `session.status` с типом `idle`, но в 7.4.23 ещё эмитится).
- «Прогресс» (текст) детектится по `message.part.updated` с ролью `assistant`; у провайдеров без стриминга текст может приходить иначе — проверять при smoke-тесте.
- Плагин — временный стоп-гэп, см. выше.

## Удаление

Когда upstream-фикс (bounded-retry пустого ответа, Kilo-Org/kilocode #12209) выйдет — удали запись `kilo-stall-nudge` из массива `plugin` в `kilo.json`.
