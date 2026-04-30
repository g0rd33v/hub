const ts = () => new Date().toISOString();

const log = (level, ...args) => {
  const msg = args
    .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  const line = `${ts()} [${level}] ${msg}`;
  if (level === 'ERROR' || level === 'WARN') console.error(line);
  else console.log(line);
};

export const logger = {
  info:  (...a) => log('INFO',  ...a),
  warn:  (...a) => log('WARN',  ...a),
  error: (...a) => log('ERROR', ...a),
  child: (prefix) => ({
    info:  (...a) => log('INFO',  `[${prefix}]`, ...a),
    warn:  (...a) => log('WARN',  `[${prefix}]`, ...a),
    error: (...a) => log('ERROR', `[${prefix}]`, ...a),
  }),
};
