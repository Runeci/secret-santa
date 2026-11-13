import { describe, expect, it } from "vitest";
import { InvalidInput, normalizePrice, normalizeUrl } from "../src/links";

describe("normalizeUrl", () => {
  it.each([
    ["https://example.com", "https://example.com"],
    ["  http://example.com/a?b=c&d=e#frag  ", "http://example.com/a?b=c&d=e#frag"],
    ["HTTPS://Example.com/Path", "HTTPS://Example.com/Path"],
    ["https://shop.example.co.uk/item/1", "https://shop.example.co.uk/item/1"],
    ["www.ozon.ru/product/123", "https://www.ozon.ru/product/123"],
    ["ozon.ru", "https://ozon.ru"],
    ["market.yandex.ru/product--x/1?sku=2&utm_source=a", "https://market.yandex.ru/product--x/1?sku=2&utm_source=a"],
    ["https://пример.рф/страница", "https://пример.рф/страница"],
    ["пример.рф", "https://пример.рф"],
    ["https://example.com/" + "a".repeat(1400), "https://example.com/" + "a".repeat(1400)],
  ])("принимает %s", (input, expected) => expect(normalizeUrl(input)).toBe(expected));

  it.each([
    "", "   ", "купить книгу", "hello", "https://", "http://", "ftp://example.com/x", "javascript:alert(1)",
    "mailto:a@b.com", "data:text/html,hi", "https://localhost/x", "https://example", "http://192.168.0.1/x",
    "https://exa mple.com", "https://user:pass@example.com", "a@b.com", "example..com", "-bad.com", "https://example.c",
    "https://example.com/" + "a".repeat(1600),
  ])("отклоняет %j", (input) => expect(() => normalizeUrl(input)).toThrow(InvalidInput));
});

describe("normalizePrice", () => {
  it.each([["3000", "3000"], [" 3 000  ₽ ", "3 000 ₽"], ["$20", "$20"], ["около 2500 руб.", "около 2500 руб."], ["1,5 тыс", "1,5 тыс"]])(
    "принимает %j", (i, o) => expect(normalizePrice(i)).toBe(o));
  it.each(["", "  ", "дорого", "много денег", "1".repeat(31)])("отклоняет %j", (i) =>
    expect(() => normalizePrice(i)).toThrow(InvalidInput));
});
