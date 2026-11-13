/** Проверка и нормализация ссылки и стоимости подарка. Чистые функции, без Telegram и БД. */
import { MAX_PRICE_LEN, MAX_URL_LEN } from "./config";

export class InvalidInput extends Error {}

// «ozon.ru/product/1», «www.shop.com» — домен без схемы: допускаем и подставляем https://
const SCHEMELESS = /^(?:[a-z0-9Ѐ-ӿ](?:[a-z0-9Ѐ-ӿ-]*[a-z0-9Ѐ-ӿ])?\.)+[a-zЀ-ӿ]{2,}(?:[/?#]\S*)?$/i;

/** Возвращает ссылку в виде, пригодном для хранения (с https://, если схемы не было). */
export function normalizeUrl(input: string): string {
  let s = input.trim();
  if (!s) throw new InvalidInput("Пришлите ссылку.");
  if (/\s/.test(s))
    throw new InvalidInput(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
        ? "В ссылке не должно быть пробелов."
        : "Это не похоже на ссылку. Пример: https://example.com/товар",
    );
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (!SCHEMELESS.test(s)) throw new InvalidInput("Это не похоже на ссылку. Пример: https://example.com/товар");
    s = "https://" + s;
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new InvalidInput("Это не похоже на ссылку. Пример: https://example.com/товар");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new InvalidInput("Ссылка должна начинаться с http:// или https://");
  if (u.username || u.password) throw new InvalidInput("Ссылка не должна содержать логин или пароль.");
  // домен вида «название.зона»: без localhost, одиночных слов и IP-адресов
  if (!/^(?:[^.]+\.)+(?:[a-z]{2,}|xn--[a-z0-9-]+)$/i.test(u.hostname))
    throw new InvalidInput("Не вижу в ссылке настоящего сайта. Пример: https://example.com/товар");
  if ([...s].length > MAX_URL_LEN) throw new InvalidInput(`Слишком длинная ссылка: максимум ${MAX_URL_LEN} символов.`);
  return s;
}

/** Стоимость — произвольный короткий текст с цифрами: «3000», «около 2 500 ₽», «$20». */
export function normalizePrice(input: string): string {
  const s = input.trim().replace(/\s+/g, " ");
  if (!s) throw new InvalidInput("Укажите стоимость, например 3000 ₽.");
  if (!/\d/.test(s)) throw new InvalidInput("В стоимости должна быть хотя бы одна цифра, например 3000 ₽.");
  if ([...s].length > MAX_PRICE_LEN) throw new InvalidInput(`Слишком длинно: максимум ${MAX_PRICE_LEN} символов.`);
  return s;
}
