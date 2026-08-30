const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let threshold = LEVELS.info;

export function setLevel(name) {
  if (name in LEVELS) threshold = LEVELS[name];
}

const tag = (level) => {
  const color = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' }[level];
  return `${color}[${level.toUpperCase()}]\x1b[0m`;
};

const log = (level, ...args) => {
  if (LEVELS[level] >= threshold) {
    if (level === 'error') console.error(tag(level), ...args);
    else if (level === 'warn') console.warn(tag(level), ...args);
    else console.log(tag(level), ...args);
  }
};

export const logger = {
  debug: (...a) => log('debug', ...a),
  info: (...a) => log('info', ...a),
  warn: (...a) => log('warn', ...a),
  error: (...a) => log('error', ...a),
  section: (title) => {
    if (LEVELS.info >= threshold) {
      console.log(`\n\x1b[1m=== ${title} ===\x1b[0m`);
    }
  },
};

export default logger;
