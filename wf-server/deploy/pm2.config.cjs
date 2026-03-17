module.exports = {
  apps: [
    {
      name: 'wf-server',
      script: 'wf-server/server.js',
      cwd: process.cwd(),
      env: {
        WF_PORT: 8788,
        WF_DB_PATH: './wf-server/data/wf.db',
        WF_AI_PROVIDER: 'mock'
      }
    }
  ]
};
