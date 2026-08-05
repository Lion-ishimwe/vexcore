import nodemailer from 'nodemailer'

export const APP_URL = (process.env.APP_URL || 'http://localhost:5330').replace(/\/$/, '')
export const mailConfigured = !!process.env.SMTP_HOST

const transport = mailConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: +(process.env.SMTP_PORT || 587),
      secure: +(process.env.SMTP_PORT || 587) === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    })
  : null

// Body lines carry user-controlled text (names, company names, phase names, and
// on the public demo form, anything a stranger types). They are intentionally
// allowed to contain <b>/<i> for emphasis, so everything else is escaped and
// only that short whitelist is put back.
const SAFE_TAGS = /&lt;(\/?)(b|i|em|strong|br)&gt;/g

function escLine(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(SAFE_TAGS, '<$1$2>')
}

// A link in an email must not be able to run script or leave our own origin
// unexpectedly - only http(s) URLs are ever emitted.
function safeUrl(u) {
  const raw = String(u ?? '')
  if (!/^https?:\/\//i.test(raw)) return null
  return raw.replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E')
}

// One branded shell for every email: amber accent, big title, optional button.
function shell({ title, lines = [], buttonText, buttonUrl, footer }) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const url = safeUrl(buttonUrl)
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Segoe UI,Arial,sans-serif;padding:24px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden">
      <tr><td style="background:#1c2430;padding:18px 28px">
        <span style="display:inline-block;background:#f59e0b;color:#1c2430;font-weight:800;border-radius:8px;padding:4px 10px;font-size:15px">B</span>
        <span style="color:#ffffff;font-weight:700;font-size:15px;margin-left:10px">CMS - Construction Management System</span>
      </td></tr>
      <tr><td style="padding:28px">
        <h2 style="margin:0 0 14px;font-size:19px;color:#10151d">${esc(title)}</h2>
        ${lines.map((l) => `<p style="margin:0 0 10px;font-size:14px;line-height:1.6;color:#334155">${escLine(l)}</p>`).join('')}
        ${url ? `<p style="margin:22px 0 8px"><a href="${url}"
          style="background:#f59e0b;color:#1c2430;font-weight:700;text-decoration:none;padding:11px 22px;border-radius:9px;font-size:14px;display:inline-block">${esc(buttonText ?? 'Open')}</a></p>
          <p style="margin:0;font-size:11.5px;color:#94a3b8">Or copy this link: ${esc(url)}</p>` : ''}
      </td></tr>
      <tr><td style="padding:14px 28px;border-top:1px solid #e5e7eb">
        <p style="margin:0;font-size:11.5px;color:#94a3b8">${esc(footer ?? 'Sent automatically by CMS (Construction Management System) - no reply needed.')}</p>
      </td></tr>
    </table>
  </td></tr></table></body></html>`
}

// Fire-and-forget: a failed email never breaks the request that triggered it.
export async function sendMail(to, subject, opts) {
  // Anything with a newline or a comma in it would inject extra headers or
  // recipients once joined into the `to:` field.
  const clean = (e) => typeof e === 'string' && /^[^\s,;<>"\\]+@[^\s,;<>"\\]+\.[a-zA-Z]{2,}$/.test(e.trim())
  const list = (Array.isArray(to) ? to : [to]).filter(clean).map((e) => e.trim())
  if (!list.length) return { skipped: true }
  subject = String(subject ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200)
  if (!transport) {
    console.log(`[mail:dev] to=${list.join(', ')} · subject="${subject}"${opts.buttonUrl ? ` · link=${opts.buttonUrl}` : ''}`)
    return { dev: true }
  }
  try {
    // Multipart (plain text + HTML) - HTML-only mail is a spam-filter red flag,
    // especially at Outlook/Hotmail. The text part mirrors the HTML content.
    const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, '')
    const text = [
      opts.title,
      '',
      ...(opts.lines ?? []).map(strip),
      ...(opts.buttonUrl ? ['', `${strip(opts.buttonText ?? 'Open')}: ${opts.buttonUrl}`] : []),
      '',
      'Sent automatically by CMS (Construction Management System).',
    ].join('\n')
    await transport.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: list.join(', '),
      replyTo: process.env.MAIL_REPLY_TO || undefined,
      subject,
      text,
      html: shell(opts),
    })
    return { ok: true }
  } catch (e) {
    console.error('[mail] send failed:', e.message)
    return { error: e.message }
  }
}
