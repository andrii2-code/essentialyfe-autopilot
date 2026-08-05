// Outbound email — password resets now, the Milestone-2 daily digest next.
//
// Two delivery routes, tried in this order:
//   1. Resend  — set RESEND_API_KEY. Sends over HTTPS from a domain verified in
//      Resend (essentialyfehub.com), so SPF/DKIM pass and the mail is far less
//      likely to be filtered than a personal mailbox would be.
//   2. SMTP    — set SMTP_HOST/SMTP_USER/SMTP_PASS (587 STARTTLS or 465 TLS).
//      Dependency-free client below; kept as a fallback and for hosts without
//      outbound HTTPS to Resend.
//
// MAIL_FROM sets the sending address (must be on the verified domain when using
// Resend); MAIL_FROM_NAME sets the display name recipients see in their inbox.
//
// If neither route is configured, send() does NOT throw — it logs the message and
// reports delivered:false, so a reset link is never silently lost.

const net = require('net');
const tls = require('tls');

function mailMode() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) return 'smtp';
  return 'log';
}

// The bare address (SMTP envelope / Resend `from` address part). MAIL_FROM may carry
// a display name — e.g. `EssentiaLyfe <noreply@…>` — so strip it down here; the
// envelope must never include the display name.
function fromAddress() {
  const raw = process.env.MAIL_FROM || process.env.SMTP_USER || 'noreply@essentialyfehub.com';
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim();
}

// What the recipient sees in the From line. MAIL_FROM_NAME shows the product name
// instead of a bare address, so an inbox lists "EssentiaLyfe".
function fromHeader() {
  const raw = process.env.MAIL_FROM || process.env.SMTP_USER || 'noreply@essentialyfehub.com';
  if (/</.test(raw)) return raw.trim(); // already "Name <addr>"
  const name = process.env.MAIL_FROM_NAME;
  return name ? `${name} <${fromAddress()}>` : fromAddress();
}

// ---- Resend (HTTPS) ----
// Throws on a non-2xx so send() can log the body and report delivered:false.
async function resendSend({ to, subject, text, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    // Send both parts when html is given: the client picks the rich one, and the text
    // stays as the fallback for plain-text readers and spam scoring.
    body: JSON.stringify({ from: fromHeader(), to: [to], subject, text, ...(html ? { html } : {}) }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Resend ${res.status}: ${body}`);
  let id = null;
  try { id = JSON.parse(body).id; } catch {}
  return id;
}

// Minimal SMTP conversation. Reads greeting/replies line-by-line and asserts the
// expected 3-digit code at each step.
function smtpSend({ host, port, user, pass, from, fromHdr, to, subject, text }) {
  return new Promise((resolve, reject) => {
    const implicitTls = Number(port) === 465;
    const socket = implicitTls
      ? tls.connect({ host, port: Number(port), servername: host })
      : net.connect({ host, port: Number(port) });

    let stream = socket;
    let buf = '';
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      try { stream.end(); } catch {}
      err ? reject(err) : resolve();
    };

    const timer = setTimeout(() => finish(new Error('SMTP timed out')), 20000);

    // Each step: send a command, then expect a reply code.
    const steps = [];
    const expect = (code, command) => steps.push({ code, command });
    expect(220, null);                       // server greeting
    expect(250, `EHLO essentialyfe`);
    if (!implicitTls) {
      expect(220, 'STARTTLS');               // upgrade handled below
      expect(250, `EHLO essentialyfe`);
    }
    expect(334, 'AUTH LOGIN');
    expect(334, Buffer.from(user).toString('base64'));
    expect(235, Buffer.from(pass).toString('base64'));
    expect(250, `MAIL FROM:<${from}>`);
    expect(250, `RCPT TO:<${to}>`);
    expect(354, 'DATA');
    const body = [
      `From: ${fromHdr || from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      // dot-stuffing: a lone "." would end DATA early
      text.replace(/\r?\n\./g, '\n..'),
      '.',
    ].join('\r\n');
    expect(250, body);
    expect(221, 'QUIT');

    let i = 0;
    const attach = (s) => {
      s.setEncoding('utf8');
      s.on('data', onData);
      s.on('error', (e) => { clearTimeout(timer); finish(e); });
    };

    function onData(chunk) {
      buf += chunk;
      // A reply may span lines: "250-..." continues, "250 ..." ends.
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (/^\d{3}-/.test(line)) continue; // multiline continuation
        const code = Number(line.slice(0, 3));
        const step = steps[i];
        if (!step) return;
        if (code !== step.code) {
          clearTimeout(timer);
          return finish(new Error(`SMTP ${line}`));
        }
        i++;
        const next = steps[i];
        if (!next) { clearTimeout(timer); return finish(null); }

        // STARTTLS: upgrade the socket, then continue the script on the TLS stream.
        if (steps[i - 1].command === 'STARTTLS' && !implicitTls && code === 220) {
          s.removeListener('data', onData);
          const secure = tls.connect({ socket: s, servername: host }, () => {
            stream = secure;
            attach(secure);
            secure.write(next.command + '\r\n');
            i++;
          });
          secure.on('error', (e) => { clearTimeout(timer); finish(e); });
          return;
        }
        if (next.command != null) s.write(next.command + '\r\n');
      }
    }

    socket.on('connect', () => {});
    attach(socket);
  });
}

// Never throws. Returns { delivered, mode, id? }.
// `html` is optional; the SMTP fallback sends the text part only, which is acceptable
// for a fallback path.
async function send({ to, subject, text, html }) {
  const mode = mailMode();

  if (mode === 'log') {
    console.log(`[mail:log] to=${to} subject="${subject}"\n${text}`);
    return { delivered: false, mode };
  }

  try {
    if (mode === 'resend') {
      const id = await resendSend({ to, subject, text, html });
      console.log(`[mail:sent] via resend to=${to} subject="${subject}" id=${id}`);
      return { delivered: true, mode, id };
    }
    await smtpSend({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT || 587,
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from: fromAddress(),
      fromHdr: fromHeader(),
      to, subject, text,
    });
    console.log(`[mail:sent] via smtp to=${to} subject="${subject}"`);
    return { delivered: true, mode };
  } catch (e) {
    // If Resend fails but SMTP is also configured, try it rather than dropping the
    // mail — a reset link is time-sensitive.
    const canFallBack = mode === 'resend'
      && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS;
    if (canFallBack) {
      console.error(`[mail:resend-failed] ${e.message} — falling back to SMTP`);
      try {
        await smtpSend({
          host: process.env.SMTP_HOST,
          port: process.env.SMTP_PORT || 587,
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
          from: fromAddress(),
          fromHdr: fromHeader(),
          to, subject, text,
        });
        console.log(`[mail:sent] via smtp (fallback) to=${to}`);
        return { delivered: true, mode: 'smtp' };
      } catch (e2) {
        console.error(`[mail:failed] to=${to} resend=(${e.message}) smtp=(${e2.message}) — content follows\n${text}`);
        return { delivered: false, mode, error: e2.message };
      }
    }
    // Log the content so the action is never silently lost.
    console.error(`[mail:failed] to=${to} (${e.message}) — content follows\n${text}`);
    return { delivered: false, mode, error: e.message };
  }
}

module.exports = { send, mailMode, fromAddress, fromHeader };
