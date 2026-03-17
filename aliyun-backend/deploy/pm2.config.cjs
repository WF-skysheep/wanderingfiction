module.exports = {
  apps: [
    {
      name: 'wanderingfiction-api',
      script: './aliyun-backend/server.js',
      cwd: '/var/www/wanderingfiction',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 8788,
      },
      env_file: './aliyun-backend/.env',
      error_file: './aliyun-backend/logs/error.log',
      out_file: './aliyun-backend/logs/out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
