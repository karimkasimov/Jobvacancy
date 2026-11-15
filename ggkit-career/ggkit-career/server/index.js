'use strict';
const { createApp } = require('./app');

const app = createApp();
const { config } = app;

if (config.isProduction) {
  if (!config.cookieSecure) console.warn('[предупреждение] COOKIE_SECURE выключен: в production сайт должен работать по HTTPS.');
  if (config.mail.provider === 'console') console.warn('[предупреждение] MAIL_PROVIDER=console не предназначен для production.');
}

app.listen().then((port) => {
  console.log(`ГГКИТ Карьера ЧР запущена: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}`);
  console.log(`База данных: ${config.databasePath}`);
  if (config.mail.provider === 'none') console.log('Почта не настроена (MAIL_PROVIDER=none): письма не отправляются.');
}).catch((err) => {
  console.error('Не удалось запустить сервер:', err.message);
  process.exit(1);
});

const shutdown = () => app.close().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
