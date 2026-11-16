// pm2 : pm2 start deploy/ecosystem.config.cjs
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'leto-api',
      script: 'dist/main.js',
      cwd: path.join(__dirname, '..'), // .env et uploads/ sont lus depuis le dossier du backend
      env: { NODE_ENV: 'production' },
      max_memory_restart: '400M',
      time: true,
    },
  ],
};
