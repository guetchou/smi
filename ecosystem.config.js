// ─── ENVIRONNEMENT LOCAL (DÉVELOPPEMENT) ────────────────────────────────────
// Ce fichier ne sert qu'au poste de développement (WSL local, port 3337).
// La PRODUCTION tourne sur le VPS OVH via Docker — jamais via PM2.
// Voir CLAUDE.md pour le flux de déploiement.
module.exports = {
  apps: [{
    name: 'caisse-topcenter',
    script: './backend/server.js',
    cwd: '/opt/frappe_docker/caisse-topcenter',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'development',
      PORT: 3337,
      JWT_SECRET: 'dev-only-secret-not-production',
      DB_PATH: '/opt/frappe_docker/caisse-topcenter/backend/data/caisse.db'
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/opt/frappe_docker/caisse-topcenter/logs/error.log',
    out_file:   '/opt/frappe_docker/caisse-topcenter/logs/out.log',
    merge_logs: true
  }]
};
