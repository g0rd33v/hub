module.exports = {
  apps: [{
    name:                 'hub',
    script:               '/opt/hub/hub/server.js',
    cwd:                  '/opt/hub',
    instances:            1,
    exec_mode:            'fork',
    autorestart:          true,
    max_memory_restart:   '512M',
    error_file:           '/var/log/hub/error.log',
    out_file:             '/var/log/hub/server.log',
    merge_logs:           true,
    time:                 true,
    env: {
      NODE_ENV: 'production',
    },
  }],
};
