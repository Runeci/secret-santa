#!/usr/bin/env bash
# Установка на Ubuntu/Debian (Oracle Cloud Always Free и любой другой VPS).
# Запуск от root из корня репозитория: sudo bash deploy/install.sh
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"

apt-get update -y
apt-get install -y python3 python3-venv rsync

id santa >/dev/null 2>&1 || useradd --system --home /opt/secret-santa --shell /usr/sbin/nologin santa
mkdir -p /opt/secret-santa /var/lib/santa-bot
rsync -a --delete --exclude .git --exclude .venv --exclude '*.db' "$SRC"/ /opt/secret-santa/
python3 -m venv /opt/secret-santa/.venv
/opt/secret-santa/.venv/bin/pip install -q -r /opt/secret-santa/requirements.txt
chown -R santa:santa /opt/secret-santa /var/lib/santa-bot

if [ ! -f /etc/santa-bot.env ]; then
  printf 'BOT_TOKEN=\nDB_PATH=/var/lib/santa-bot/santa.db\n' > /etc/santa-bot.env
  chmod 600 /etc/santa-bot.env
  echo ">>> Впишите токен: sudo nano /etc/santa-bot.env"
fi

cp /opt/secret-santa/deploy/santa-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable santa-bot
echo ">>> Готово. После вписывания токена: sudo systemctl restart santa-bot && journalctl -u santa-bot -f"
