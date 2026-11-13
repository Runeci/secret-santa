/** Даты и часовые пояса для дедлайна. Чистые функции. Часовой пояс — целый сдвиг от UTC в часах. */
import { InvalidInput } from "./links";

export interface YMD {
  y: number;
  m: number;
  d: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const ymdToString = ({ y, m, d }: YMD): string => `${y}-${pad(m)}-${pad(d)}`;
export const formatRu = (s: string): string => {
  const { y, m, d } = parseYMD(s);
  return `${pad(d)}.${pad(m)}.${y}`;
};
export function parseYMD(s: string): YMD {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}
/** Номер дня (для разности дат без путаницы с часами). */
export const dayNumber = ({ y, m, d }: YMD): number => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
export const weekday = ({ y, m, d }: YMD): number => new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = воскресенье, 6 = суббота

/** Местные дата, час и день недели для момента nowMs в поясе offset (часы от UTC). */
export function localNow(nowMs: number, offset: number): YMD & { hour: number; weekday: number } {
  const t = new Date(nowMs + offset * 3_600_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), hour: t.getUTCHours(), weekday: t.getUTCDay() };
}

const isRealDate = ({ y, m, d }: YMD): boolean => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

const BAD_FORMAT = "Не понял дату. Напишите, например: 20.12 или 20.12.2026";
const MAX_DAYS_AHEAD = 400;

/** Разбор даты, введённой организатором: 20.12, 20.12.2026, 20/12/26, 2026-12-20. Без года — ближайшая будущая. */
export function parseDateInput(input: string, nowMs: number): YMD {
  const s = input.trim();
  let m: RegExpExecArray | null;
  let ymd: YMD;
  const today = localNow(nowMs, 0);
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) {
    ymd = { y: +m[1], m: +m[2], d: +m[3] };
  } else if ((m = /^(\d{1,2})[./\s-](\d{1,2})(?:[./\s-](\d{2}|\d{4}))?$/.exec(s))) {
    const hasYear = m[3] !== undefined;
    let y = hasYear ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : today.y;
    ymd = { y, m: +m[2], d: +m[1] };
    // без года: если дата в этом году уже прошла — берём следующий
    if (!hasYear && isRealDate(ymd) && dayNumber(ymd) < dayNumber(today)) ymd = { ...ymd, y: y + 1 };
  } else {
    throw new InvalidInput(BAD_FORMAT);
  }
  if (!isRealDate(ymd)) throw new InvalidInput("Такой даты не существует. Проверьте день и месяц.");
  // запас в сутки: точная проверка «не в прошлом» — после выбора часового пояса
  const diff = dayNumber(ymd) - dayNumber(today);
  if (diff < -1) throw new InvalidInput("Эта дата уже прошла.");
  if (diff > MAX_DAYS_AHEAD) throw new InvalidInput("Слишком далеко: выберите дату в пределах года.");
  return ymd;
}

/** Склонение «дней»: 1 день, 2 дня, 5 дней. */
export function daysWord(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? "день" : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "дня" : "дней"}`;
}

export const tzLabel = (offset: number): string => `UTC${offset >= 0 ? "+" : "−"}${Math.abs(offset)}`;
