'use strict';

/**
 * Интерфейс отправки писем. Провайдер задаётся MAIL_PROVIDER:
 *   none    — почта не настроена, письма не отправляются (по умолчанию);
 *   console — только для разработки: текст письма выводится в консоль сервера;
 *   webhook — POST JSON на MAIL_WEBHOOK_URL (подходит для любого HTTP-API почтового сервиса);
 *   memory  — для автотестов, письма складываются в outbox.
 * Для SMTP или конкретного сервиса достаточно добавить ещё один провайдер в send().
 */
function createMailer(config) {
  const provider = config.mail.provider;
  const outbox = [];

  async function send({ to, subject, text }) {
    if (provider === 'none') return { delivered: false, channel: 'none' };

    if (provider === 'console') {
      outbox.push({ to, subject, text });
      console.log(`\n[mail:console] Кому: ${to}\nТема: ${subject}\n${text}\n`);
      return { delivered: true, channel: 'console' };
    }

    if (provider === 'memory') {
      outbox.push({ to, subject, text });
      return { delivered: true, channel: 'memory' };
    }

    if (provider === 'webhook') {
      if (!config.mail.webhookUrl) return { delivered: false, channel: 'none' };
      try {
        const res = await fetch(config.mail.webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.mail.webhookToken ? { Authorization: `Bearer ${config.mail.webhookToken}` } : {}),
          },
          body: JSON.stringify({ from: config.mail.from, to, subject, text }),
          signal: AbortSignal.timeout(8000),
        });
        return { delivered: res.ok, channel: 'webhook' };
      } catch (err) {
        console.error('[mail:webhook] ошибка отправки:', err.message);
        return { delivered: false, channel: 'webhook' };
      }
    }

    return { delivered: false, channel: 'none' };
  }

  return { provider, outbox, send, isConfigured: provider !== 'none' };
}

module.exports = { createMailer };
