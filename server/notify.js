// Outbound messages: Slack (incoming webhook), email (Resend or SendGrid HTTP API), SMS (Twilio).
// Every channel is optional. When a channel is not configured the message is logged instead, so
// nothing here can stop the server from running.
const cfg = require('./config');

const log = (...a) => console.log('[notify]', ...a);

async function slack(text) {
  const url = cfg.slack && cfg.slack.webhookUrl;
  if (!url) { log('slack (not configured):', text); return false; }
  try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); return r.ok; }
  catch (e) { log('slack failed', e.message); return false; }
}

async function email(subject, text, to) {
  const em = cfg.email || {}; const rcpts = to || em.to || [];
  if (!em.provider || em.provider === 'none' || !em.apiKey || !rcpts.length) { log('email (not configured):', subject, '->', rcpts.join(','), '\n', text); return false; }
  try {
    if (em.provider === 'resend') {
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + em.apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ from: em.from, to: rcpts, subject, text }) });
      return r.ok;
    }
    if (em.provider === 'sendgrid') {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', { method: 'POST', headers: { authorization: 'Bearer ' + em.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ personalizations: [{ to: rcpts.map(e => ({ email: e })) }], from: { email: em.from }, subject, content: [{ type: 'text/plain', value: text }] }) });
      return r.ok;
    }
    log('email provider not recognised:', em.provider); return false;
  } catch (e) { log('email failed', e.message); return false; }
}

async function sms(to, text) {
  const s = cfg.sms || {};
  if (!s.provider || s.provider === 'none' || !s.accountSid || !s.authToken || !s.from) { log('sms (not configured) ->', to, ':', text); return false; }
  try {
    if (s.provider === 'twilio') {
      const body = new URLSearchParams({ To: '+1' + to, From: s.from, Body: text });
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${s.accountSid}/Messages.json`, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(s.accountSid + ':' + s.authToken).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body });
      return r.ok;
    }
    log('sms provider not recognised:', s.provider); return false;
  } catch (e) { log('sms failed', e.message); return false; }
}

module.exports = { slack, email, sms };
