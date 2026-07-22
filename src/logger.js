const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

export function createLogger(scope) {
  const emit = (level, sink) => (...args) => {
    if (LEVELS[level] < threshold) return;
    sink(`${stamp()} ${level.toUpperCase().padEnd(5)} [${scope}]`, ...args);
  };

  return {
    debug: emit('debug', console.log),
    info: emit('info', console.log),
    warn: emit('warn', console.warn),
    error: emit('error', console.error),
  };
}
