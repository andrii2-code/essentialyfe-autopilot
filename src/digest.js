// The daily email: what came in overnight and which known properties moved price.
//
// Sent to every admin (they are the people who act on it). Nothing is marked as
// reported until the send actually succeeds, so a failed or unconfigured send means
// tomorrow's email still carries today's properties rather than losing them.
//
// Scheduling is deliberately not here: `sendDigest()` is called by the "Send now"
// button and is what a cron/scheduler would call too.

const { q } = require('./db');
const mailer = require('./mailer');

const money = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function appUrl() {
  return (process.env.APP_URL || 'https://www.essentialyfehub.com').replace(/\/$/, '');
}

// Plain-text part — also what gets logged when no sender is configured.
function renderText({ newListings, priceChanges }) {
  const lines = [];
  lines.push(`EssentiaLyfe — Sourcing Autopilot`);
  lines.push('');
  if (newListings.length) {
    lines.push(`${newListings.length} new propert${newListings.length === 1 ? 'y' : 'ies'} waiting for review:`);
    for (const l of newListings) {
      lines.push(`  · ${l.street_line || l.address} — ${money(l.price)}${l.is_rental ? '/mo' : ''}`
        + `  ${l.beds ?? '?'}bd/${l.baths ?? '?'}ba`
        + (l.sqft ? `  ${Number(l.sqft).toLocaleString()} sqft` : ''));
    }
    lines.push('');
  }
  if (priceChanges.length) {
    lines.push(`${priceChanges.length} price change${priceChanges.length === 1 ? '' : 's'}:`);
    for (const l of priceChanges) {
      const dir = l.drop > 0 ? 'down' : 'up';
      lines.push(`  · ${l.street_line || l.address} — ${dir} ${money(Math.abs(l.drop))}`
        + ` (${money(l.previous_price)} -> ${money(l.price)})`);
    }
    lines.push('');
  }
  if (!newListings.length && !priceChanges.length) {
    lines.push('Nothing new since the last email.');
    lines.push('');
  }
  lines.push(`Review them: ${appUrl()}`);
  return lines.join('\n');
}

// HTML part — same content, readable in an inbox. Inline styles only, since email
// clients strip <style> blocks.
function renderHtml({ newListings, priceChanges }) {
  const wrap = (inner) => `
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f6f7f9;padding:24px">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden">
    <div style="background:#0f1b2d;padding:18px 22px;color:#fff">
      <div style="font-size:17px;font-weight:600;letter-spacing:.02em">EssentiaLyfe</div>
      <div style="font-size:12px;color:#9fb0c4;margin-top:2px">Sourcing Autopilot · daily summary</div>
    </div>
    <div style="padding:22px">${inner}</div>
    <div style="padding:16px 22px;border-top:1px solid #e7e9ee">
      <a href="${appUrl()}" style="display:inline-block;background:#c8a44d;color:#1a1300;text-decoration:none;
         font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px">Open the review queue</a>
    </div>
  </div>
</div>`;

  const section = (title, body) =>
    `<div style="font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#7a8698;margin:0 0 10px">${title}</div>${body}`;

  const row = (left, right) => `
    <tr>
      <td style="padding:9px 0;border-bottom:1px solid #f0f1f4;font-size:14px;color:#1b2431">${left}</td>
      <td style="padding:9px 0;border-bottom:1px solid #f0f1f4;font-size:14px;color:#1b2431;text-align:right;white-space:nowrap">${right}</td>
    </tr>`;

  let out = '';

  if (newListings.length) {
    const rows = newListings.map(l => row(
      `<b>${esc(l.street_line || l.address)}</b>`
      + `<div style="color:#7a8698;font-size:12px;margin-top:2px">${esc(l.area || l.city || '')}`
      + ` · ${l.beds ?? '?'}bd/${l.baths ?? '?'}ba${l.sqft ? ' · ' + Number(l.sqft).toLocaleString() + ' sqft' : ''}</div>`,
      `${money(l.price)}${l.is_rental ? '<span style="color:#7a8698">/mo</span>' : ''}`
    )).join('');
    out += section(`${newListings.length} new propert${newListings.length === 1 ? 'y' : 'ies'}`,
      `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:22px">${rows}</table>`);
  }

  if (priceChanges.length) {
    const rows = priceChanges.map(l => {
      const down = l.drop > 0;
      const colour = down ? '#2f9e6d' : '#c0563f';
      const arrow = down ? '▼' : '▲';
      return row(
        `<b>${esc(l.street_line || l.address)}</b>`
        + `<div style="color:#7a8698;font-size:12px;margin-top:2px">was ${money(l.previous_price)}</div>`,
        `<span style="color:${colour};font-weight:600">${arrow} ${money(Math.abs(l.drop))}</span>`
        + `<div style="color:#7a8698;font-size:12px;margin-top:2px">now ${money(l.price)}</div>`
      );
    }).join('');
    out += section(`${priceChanges.length} price change${priceChanges.length === 1 ? '' : 's'}`,
      `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows}</table>`);
  }

  if (!out) {
    out = `<div style="font-size:14px;color:#7a8698">Nothing new since the last email — the collector is still running.</div>`;
  }
  return wrap(out);
}

function subjectFor({ newListings, priceChanges }) {
  const bits = [];
  if (newListings.length) bits.push(`${newListings.length} new`);
  if (priceChanges.length) bits.push(`${priceChanges.length} price change${priceChanges.length === 1 ? '' : 's'}`);
  return bits.length ? `EssentiaLyfe — ${bits.join(', ')}` : 'EssentiaLyfe — nothing new today';
}

// Build and send. Returns what happened, and never throws — a broken email must not
// take the app down.
//   days     how far back to look (1 = since yesterday)
//   force    send even when there is nothing to report (the "Send now" button uses
//            this so a test always produces a real email)
//   to       override the recipients (used by the send-now button to mail just him)
async function sendDigest({ days = 1, force = false, to = null } = {}) {
  const contents = await q.digestContents({ days });
  const count = contents.newListings.length + contents.priceChanges.length;

  if (!count && !force) {
    return { sent: false, reason: 'nothing to report', ...tally(contents) };
  }

  let recipients = to ? (Array.isArray(to) ? to : [to]) : null;
  if (!recipients) {
    const admins = (await q.listUsers()).filter(u => u.role === 'admin').map(u => u.email);
    recipients = admins;
  }
  if (!recipients.length) {
    return { sent: false, reason: 'no admin recipients', ...tally(contents) };
  }

  const subject = subjectFor(contents);
  const text = renderText(contents);
  const html = renderHtml(contents);

  const results = [];
  for (const addr of recipients) {
    results.push({ to: addr, ...(await mailer.send({ to: addr, subject, text, html })) });
  }
  const delivered = results.filter(r => r.delivered);

  // Only mark as reported once it really went out, so a failure doesn't silently
  // swallow a day of listings.
  if (delivered.length) {
    await q.markDigestSent(contents.newListings.map(l => l.id));
  }

  return {
    sent: delivered.length > 0,
    recipients: results.map(r => ({ to: r.to, delivered: r.delivered, error: r.error })),
    mode: results[0]?.mode,
    subject,
    ...tally(contents),
  };
}

const tally = (c) => ({ newCount: c.newListings.length, priceChangeCount: c.priceChanges.length });

module.exports = { sendDigest, renderText, renderHtml, subjectFor };
