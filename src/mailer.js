// Outbound email. Dependency-free SMTP client (net/tls) so no new package is
// needed; the same sender will carry the Milestone-2 daily digest.
//
// Configure with: SMTP_HOST, SMTP_PORT (587 STARTTLS or 465 implicit TLS),
// SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_FROM_NAME.
// MAIL_FROM_NAME sets the display name recipients see ("EssentiaLyfe <addr>"), so a
// plain Gmail sending account still reads as the product in an inbox.
// If SMTP is not configured, send() does NOT throw — it logs the message and
// reports delivered:false, so a password reset still works via the server log
// (and, for the owner-recovery path, via the response) until SMTP is wired up.

const net = require('net');
const tls = require('tls');

function mailMode() {
  return process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
    ? 'smtp'
    : 'log';
}

// The bare address used in the SMTP envelope (MAIL FROM). MAIL_FROM may carry a
// display name — e.g. `EssentiaLyfe <bot@gmail.com>` — so strip it down to the
// address here; the envelope must never include the display name.
function fromAddress() {
  const raw = process.env.MAIL_FROM || process.env.SMTP_USER || 'no-reply@essentialyfe.app';
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim();
}

// What the recipient sees in the From line. Set MAIL_FROM_NAME to show a product
// name instead of a bare address — an inbox then lists "EssentiaLyfe", not a
// personal mailbox, which matters when the sending account is a plain Gmail.
function fromHeader() {
  const raw = process.env.MAIL_FROM || process.env.SMTP_USER || 'no-reply@essentialyfe.app';
  if (/</.test(raw)) return raw.trim(); // already "Name <addr>"
  const name = process.env.MAIL_FROM_NAME;
  return name ? `${name} <${fromAddress()}>` : fromAddress();
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

// Never throws. Returns { delivered, mode }.
async function send({ to, subject, text }) {
  const mode = mailMode();
  if (mode !== 'smtp') {
    console.log(`[mail:log] to=${to} subject="${subject}"\n${text}`);
    return { delivered: false, mode };
  }
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
    console.log(`[mail:sent] to=${to} subject="${subject}"`);
    return { delivered: true, mode };
  } catch (e) {
    // Log the content so the action is never silently lost.
    console.error(`[mail:failed] to=${to} (${e.message}) — content follows\n${text}`);
    return { delivered: false, mode, error: e.message };
  }
}

module.exports = { send, mailMode, fromAddress, fromHeader };
