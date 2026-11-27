const DAY = /^\d{4}-\d{2}-\d{2}$/;
const time = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Shanghai",
});
const money = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 2 });

export function businessDay(value = new Date()): string {
  return value.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

export function displayTime(value: string | null | undefined): string {
  if (!value) return "未安排";
  if (DAY.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "日期待核对" : time.format(date);
}

export function dateAndTimeIso(value: string): string {
  return new Date(value + ":00+08:00").toISOString();
}

export function displayMoney(amount: number | null): string {
  return amount === null ? "待接入" : money.format(amount / 100);
}
