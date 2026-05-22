import { AsyncLocalStorage } from "node:async_hooks";
import { loadConfig } from "../config.js";

type LogLevel = "debug" | "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

const SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const logSuppression = new AsyncLocalStorage<boolean>();

function currentThreshold(): number {
  try {
    return SEVERITY[loadConfig().logLevel];
  } catch {
    return SEVERITY.info;
  }
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  if (logSuppression.getStore() === true) return;
  if (SEVERITY[level] < currentThreshold()) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(fields ?? {})
  };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

export const log = {
  debug(message: string, fields?: LogFields): void {
    emit("debug", message, fields);
  },
  info(message: string, fields?: LogFields): void {
    emit("info", message, fields);
  },
  warn(message: string, fields?: LogFields): void {
    emit("warn", message, fields);
  },
  error(message: string, fields?: LogFields): void {
    emit("error", message, fields);
  }
};

export async function withSuppressedLogs<T>(fn: () => Promise<T>): Promise<T> {
  return await logSuppression.run(true, fn);
}
