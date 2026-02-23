module.exports = {
  apps: [{
    name: 'sls-collector',
    script: 'src/index.ts',
    interpreter: 'node',
    interpreter_args: '--import tsx',
    cwd: 'C:\\dev\\livespot\\collector',
    env: {
      NODE_ENV: 'production',
    },
    // 自動再起動
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    // ログ
    log_file: 'C:\\dev\\livespot\\collector\\logs\\collector.log',
    error_file: 'C:\\dev\\livespot\\collector\\logs\\error.log',
    out_file: 'C:\\dev\\livespot\\collector\\logs\\out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    // クラッシュ時の再起動制御
    restart_delay: 10000,
    max_restarts: 50,
    min_uptime: '30s',
  }],
};
