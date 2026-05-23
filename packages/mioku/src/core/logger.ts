type LogMethod = (...args: unknown[]) => void;

export interface MiokuLogger {
  error: LogMethod;
  warn: LogMethod;
  info: LogMethod;
  debug: LogMethod;
  trace?: LogMethod;
}

const fallbackLogger: MiokuLogger = {
  error: (...args) => console.error(...args),
  warn: (...args) => console.warn(...args),
  info: (...args) => console.info(...args),
  debug: (...args) => console.debug(...args),
  trace: (...args) => console.debug(...args),
};

let activeLogger: MiokuLogger = fallbackLogger;

export function setMiokuLogger(logger: MiokuLogger | undefined): void {
  activeLogger = logger || fallbackLogger;
}

export function getMiokuLogger(): MiokuLogger {
  return activeLogger;
}

export const logger: MiokuLogger = {
  error: (...args) => activeLogger.error(...args),
  warn: (...args) => activeLogger.warn(...args),
  info: (...args) => activeLogger.info(...args),
  debug: (...args) => activeLogger.debug(...args),
  trace: (...args) => activeLogger.trace?.(...args),
};
