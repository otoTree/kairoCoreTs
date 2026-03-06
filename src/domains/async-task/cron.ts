import type { RepeatStrategy } from "./async-task.types";

export function normalizeRepeat(input: unknown): RepeatStrategy | undefined {
  if (!input || typeof input !== "object") return undefined;
  const repeat = input as RepeatStrategy;
  const hasInterval = typeof repeat.intervalMs === "number" && Number.isFinite(repeat.intervalMs);
  const hasCron = typeof repeat.cron === "string" && repeat.cron.trim().length > 0;
  if (!hasInterval && !hasCron) {
    return undefined;
  }
  if (hasInterval && hasCron) {
    throw new Error("repeat.intervalMs and repeat.cron cannot be used together");
  }
  if (hasInterval && repeat.intervalMs! <= 0) {
    throw new Error("repeat.intervalMs must be > 0");
  }
  if (hasCron) {
    const cron = repeat.cron!.trim();
    validateCronExpression(cron);
    return { cron };
  }
  return { intervalMs: repeat.intervalMs };
}

export function resolveNextRun(repeat: RepeatStrategy, from: number): number {
  if (repeat.intervalMs) {
    return from + repeat.intervalMs;
  }
  if (repeat.cron) {
    return nextCronExecution(repeat.cron, from);
  }
  throw new Error("Invalid repeat strategy");
}

function validateCronExpression(expression: string) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression: ${expression}`);
  }
  parseCronMatcher(fields[0], 0, 59);
  parseCronMatcher(fields[1], 0, 23);
  parseCronMatcher(fields[2], 1, 31);
  parseCronMatcher(fields[3], 1, 12);
  parseCronMatcher(fields[4], 0, 6);
}

function nextCronExecution(expression: string, fromTime: number): number {
  const fields = expression.trim().split(/\s+/);
  const minute = parseCronMatcher(fields[0], 0, 59);
  const hour = parseCronMatcher(fields[1], 0, 23);
  const day = parseCronMatcher(fields[2], 1, 31);
  const month = parseCronMatcher(fields[3], 1, 12);
  const weekDay = parseCronMatcher(fields[4], 0, 6);

  const cursor = new Date(fromTime);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const maxChecks = 60 * 24 * 366;
  for (let i = 0; i < maxChecks; i += 1) {
    if (
      minute(cursor.getMinutes())
      && hour(cursor.getHours())
      && day(cursor.getDate())
      && month(cursor.getMonth() + 1)
      && weekDay(cursor.getDay())
    ) {
      return cursor.getTime();
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  throw new Error(`Unable to resolve next cron time for ${expression}`);
}

function parseCronMatcher(field: string, min: number, max: number): (value: number) => boolean {
  const token = field.trim();
  if (token === "*") {
    return () => true;
  }
  if (token.startsWith("*/")) {
    const step = Number(token.slice(2));
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid cron step: ${field}`);
    }
    return (value: number) => (value - min) % step === 0;
  }
  if (token.includes(",")) {
    const parts = token.split(",").map((part) => part.trim());
    const rules = parts.map((part) => parseCronMatcher(part, min, max));
    return (value: number) => rules.some((rule) => rule(value));
  }
  const fixed = Number(token);
  if (!Number.isInteger(fixed) || fixed < min || fixed > max) {
    throw new Error(`Invalid cron field: ${field}`);
  }
  return (value: number) => value === fixed;
}
