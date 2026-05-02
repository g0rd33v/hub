import 'dotenv/config';

const def = (k, fallback) => process.env[k] || fallback;

export const config = {
  serverNumber: parseInt(def('SERVER_NUMBER', '0'), 10),
  publicBase: def('PUBLIC_BASE', 'http://localhost:3100'),
  port: parseInt(def('HUB_PORT', '3100'), 10),
  dataDir: def('HUB_DATA_DIR', '/var/lib/hub'),
  configDir: def('HUB_CONFIG_DIR', '/etc/hub'),
  nodeEnv: def('NODE_ENV', 'development'),
  modules: {
    drafts: true,
    runtime: true,
    buffer: true,
    telegram: true,
    analytics: true,
    wizard: true,
    botctl: true,
  },
};

export const paths = {
  projects:        ()    => `${config.dataDir}/projects`,
  project:         (n)   => `${config.dataDir}/projects/${n}`,
  projectLive:     (n)   => `${config.dataDir}/projects/${n}/live`,
  projectDrafts:   (n)   => `${config.dataDir}/projects/${n}/drafts`,
  projectVersions: (n)   => `${config.dataDir}/projects/${n}/versions`,
  projectKv:       (n)   => `${config.dataDir}/projects/${n}/runtime/kv.sqlite`,
  state:           ()    => `${config.dataDir}/state.json`,
  sapToken:        ()    => `${config.configDir}/sap.token`,
  masterBotToken:  ()    => `${config.configDir}/master-bot.token`,
};
