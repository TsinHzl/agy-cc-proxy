module.exports = {
  apps: [{
    name: 'agy-cc-proxy',
    script: 'src/index.js',
    args: '--strategy=hybrid',
    interpreter: 'node',
    restart_delay: 3000,
    max_restarts: 10,
    env: {
      NODE_ENV: 'production',
      PORT: '8080'
    }
  }]
}
