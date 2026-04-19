type LogLevel = "debug" | "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

function emit(level: LogLevel, message: string, fields?: LogFields): void {
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
    if (process.env.AUTOVAULT_LOG_LEVEL === "debug") emit("debug", message, fields);
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
