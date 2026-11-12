#!/usr/bin/env bash
# Регистрирует webhook в Telegram. Значения берутся из переменных окружения, чтобы токен не попал в историю команд.
#   BOT_TOKEN=... WEBHOOK_SECRET=... WORKER_URL=https://secret-santa-bot.<ваш-поддомен>.workers.dev bash scripts/set-webhook.sh
set -euo pipefail
: "${BOT_TOKEN:?нужна переменная BOT_TOKEN}"
: "${WEBHOOK_SECRET:?нужна переменная WEBHOOK_SECRET}"
: "${WORKER_URL:?нужна переменная WORKER_URL}"
curl -sS "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WORKER_URL%/}/webhook" \
  --data-urlencode "secret_token=${WEBHOOK_SECRET}" \
  --data-urlencode "allowed_updates=[\"message\",\"callback_query\"]" \
  --data-urlencode "drop_pending_updates=true"
echo
curl -sS "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
echo
