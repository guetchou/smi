module.exports = {
  apps: [{
    name: 'caisse-topcenter',
    script: './backend/server.js',
    interpreter: '/usr/bin/node',
    cwd: '/opt/frappe_docker/caisse-topcenter',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'production',
      PORT: 3337,
      JWT_SECRET: 'topcenter-caisse-jwt-secret-change-in-prod-2025',
      DB_PATH: '/opt/frappe_docker/caisse-topcenter/backend/data/caisse.db'
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/opt/frappe_docker/caisse-topcenter/logs/error.log',
    out_file: '/opt/frappe_docker/caisse-topcenter/logs/out.log',
    merge_logs: true
  }]
};
