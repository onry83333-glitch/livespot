type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

const RESET = '\x1b[0m';

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function formatTime(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(level: LogLevel, tag: string, message: string, data?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;

  const color = LEVEL_COLORS[level];
  const prefix = `${color}[${formatTime()}] [${level.toUpperCase()}]${RESET} [${tag}]`;

  if (data !== undefined) {
    console.log(`${prefix} ${message}`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export function createLogger(tag: string) {
  return {
    debug: (msg: string, data?: unknown) => log('debug', tag, msg, data),
    info: (msg: string, data?: unknown) => log('info', tag, msg, data),
    warn: (msg: string, data?: unknown) => log('warn', tag, msg, data),
    error: (msg: string, data?: unknown) => log('error', tag, msg, data),
  };
}
