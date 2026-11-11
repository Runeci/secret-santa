# 🎅 Тайный Санта — Telegram-бот

Python 3.12+, aiogram 3, SQLite. Работает через long polling (домен и HTTPS не нужны).

## Запуск

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env     # впишите BOT_TOKEN от @BotFather
export $(grep -v '^#' .env | xargs)
python -m santa_bot
```

База — один файл (`DB_PATH`, по умолчанию `santa.db`); делайте его бэкап.
Незаконченный ввод (название игры, текст подарка) хранится в памяти и сбрасывается при перезапуске бота.

## Тесты

```bash
pip install -r requirements-dev.txt
pytest
```

## Как это устроено

| Файл | Назначение |
|---|---|
| `santa_bot/draw.py` | жеребьёвка: чистая функция без Telegram и БД |
| `santa_bot/db.py` | схема SQLite и запросы |
| `santa_bot/service.py` | правила игры и проверки прав (организатор/участник, лимиты) |
| `santa_bot/handlers.py` | диалоги и inline-кнопки |
| `santa_bot/keyboards.py`, `texts.py` | клавиатуры и русские тексты |
| `tests/` | алгоритм, сервис и сквозные сценарии с фейковым Telegram |

**Жеребьёвка.** Сначала точная проверка, что решение существует (паросочетание в двудольном
графе). Потом случайный поиск с возвратом с бюджетом взаимных пар 0, 1, 2… — взаимные пары
появляются, только если иначе никак. Если решения нет, организатору предлагается удалить правила.

**Лимиты** (в `santa_bot/config.py`): 20 пунктов, 300 символов, минимум 3 участника,
максимум 50 участников в игре (чтобы клавиатуры помещались в лимит Telegram).

**Приватность.** Пары хранятся в таблице `assignments`; интерфейс показывает каждому только
его собственную пару, включая организатора. Администратор сервера с доступом к файлу БД
технически может их прочитать.

## Бесплатный хостинг: Oracle Cloud Always Free

Бот на long polling должен работать постоянно, поэтому подходит виртуальная машина, а не
«засыпающий» веб-тариф. Oracle Always Free даёт такую VM бесплатно (нужна банковская карта
для верификации; списаний на Always Free нет). Актуальные лимиты проверьте в консоли OCI.

1. Зарегистрируйтесь на cloud.oracle.com, создайте инстанс: образ Ubuntu 24.04, shape
   `VM.Standard.A1.Flex` (1 OCPU / 6 ГБ достаточно) или `VM.Standard.E2.1.Micro`.
   Порты открывать не нужно: бот сам обращается к Telegram, входящих соединений нет.
   Если «Out of capacity» — повторите позже или попробуйте другой домен доступности.
2. Подключитесь по SSH, склонируйте репозиторий и установите:
   ```bash
   git clone https://github.com/Runeci/secret-santa.git && cd secret-santa
   git checkout claude/magical-bardeen-o3ltqa
   sudo bash deploy/install.sh
   sudo nano /etc/santa-bot.env        # BOT_TOKEN=...
   sudo systemctl restart santa-bot
   journalctl -u santa-bot -f          # логи
   ```
3. База лежит в `/var/lib/santa-bot/santa.db` — периодически копируйте её себе.

Обновление: `git pull && sudo bash deploy/install.sh && sudo systemctl restart santa-bot`.
