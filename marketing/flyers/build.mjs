// VEXCORE social media flyers - 1080x1350 (4:5 portrait, the feed size on
// Facebook / Instagram / LinkedIn).
//
//   node marketing/flyers/build.mjs
//
// Writes html/*.html and renders png/*.png with headless Edge (or Chrome).
// Every claim on these flyers is checked against the product: plans and limits
// from api/src/plans.js, the 14-day no-card trial from routes/auth.js. Keep it
// that way - no invented customer counts or testimonials.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(here, '../../api/package.json'))
const QRCode = require('qrcode')

const SITE = 'core.vexa.rw'
const PHONE = '0785 576 541'

// ---------------------------------------------------------------- brand ----
const ICON = {
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  qr: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>',
  box: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  chart: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  swap: '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  cash: '<rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  clip: '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  print: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
}
const icon = (name, size = 28, sw = 2.2) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`

const MARK = (size = 64, bg = '#F59E0B', fg = '#0B1220') => `
<svg width="${size}" height="${size}" viewBox="0 0 48 48" aria-label="VEXCORE">
  <rect width="48" height="48" rx="12" fill="${bg}"/>
  <path d="M11 12h7.2L24 28.4 29.8 12H37l-9.6 24h-6.8z" fill="${fg}"/>
  <rect x="11" y="38.5" width="26" height="3" rx="1.5" fill="${fg}" opacity=".35"/>
</svg>`

const brand = (tone = 'dark') => `
<div class="brand ${tone}">
  ${MARK(60)}
  <div><div class="brand-name">VEXCORE</div><div class="brand-sub">Construction Management</div></div>
</div>`

const qrSvg = await QRCode.toString(`https://${SITE}`, {
  type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#0B1220', light: '#FFFFFF' },
})
// Decorative card code for the worker ID mockup (encodes a sample card id, not a link).
const cardQr = await QRCode.toString('VEXCORE-CARD-W0147', {
  type: 'svg', margin: 0, errorCorrectionLevel: 'L', color: { dark: '#0B1220', light: '#FFFFFF' },
})

const cta = (tone = 'amber', kicker = 'Start your 14-day free trial') => `
<div class="cta ${tone}">
  <div class="cta-text">
    <div class="cta-kicker">${kicker}</div>
    <div class="cta-url">${SITE}</div>
    <div class="cta-phone">${icon('phone', 24)} <b>${PHONE}</b><span>Call or WhatsApp</span></div>
  </div>
  <div class="cta-qr">${qrSvg}<div>Scan to start</div></div>
</div>`

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800;900&display=swap');
:root{--navy:#0B1220;--navy2:#111B30;--slate:#1E293B;--line:#26344F;--amber:#F59E0B;--amber2:#FBBF24;--amberD:#B45309;
  --cream:#FFF8EC;--ink:#0F172A;--muted:#94A3B8;--soft:#CBD5E1;--green:#16A34A;--red:#DC2626}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1080px;height:1350px;overflow:hidden;background:var(--navy)}
body{font-family:'Poppins',system-ui,sans-serif;-webkit-font-smoothing:antialiased;color:#fff}
.flyer{position:relative;width:1080px;height:1350px;overflow:hidden;padding:60px 76px 56px;display:flex;flex-direction:column}
.ic{flex:none;display:block}
.amber{color:var(--amber)}

/* backgrounds */
.bg-dark{background:
  radial-gradient(900px 600px at 105% -5%, rgba(245,158,11,.20), transparent 60%),
  radial-gradient(700px 500px at -10% 110%, rgba(245,158,11,.10), transparent 60%),
  linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px) 0 0/44px 44px,
  linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px) 0 0/44px 44px,
  var(--navy)}
.bg-cream{background:
  linear-gradient(rgba(15,23,42,.045) 1px, transparent 1px) 0 0/44px 44px,
  linear-gradient(90deg, rgba(15,23,42,.045) 1px, transparent 1px) 0 0/44px 44px,
  var(--cream); color:var(--ink)}
.stripe{position:absolute;left:0;right:0;height:14px;background:repeating-linear-gradient(-45deg,var(--amber) 0 22px,var(--navy) 22px 44px)}
.stripe.top{top:0}.stripe.bottom{bottom:0}

/* brand */
.brand{display:flex;align-items:center;gap:18px}
.brand-name{font-weight:800;font-size:34px;letter-spacing:.16em;line-height:1}
.brand-sub{font-size:16px;font-weight:500;letter-spacing:.06em;color:var(--muted);margin-top:6px}
.brand.light .brand-name{color:var(--ink)} .brand.light .brand-sub{color:#64748B}
.top-row{display:flex;justify-content:space-between;align-items:center}

.kicker{display:inline-flex;align-self:flex-start;align-items:center;gap:10px;margin-top:38px;padding:10px 20px;border-radius:999px;
  background:rgba(245,158,11,.14);border:1.5px solid rgba(245,158,11,.45);color:var(--amber2);font-weight:700;font-size:19px;letter-spacing:.14em}
.kicker.on-light{background:#FEF3C7;border-color:#F8D58A;color:var(--amberD)}
h1{font-weight:800;letter-spacing:-.025em;line-height:1.02;margin-top:22px}
.lede{font-size:30px;line-height:1.42;color:var(--soft);margin-top:22px;font-weight:400}
.on-light .lede,.lede.dark{color:#475569}

/* CTA footer */
.cta{display:flex;align-items:center;justify-content:space-between;gap:28px;border-radius:28px;padding:28px 30px 28px 40px;margin-top:auto}
.cta.amber{background:var(--amber);color:var(--navy)}
.cta.navy{background:var(--navy);color:#fff}
.cta-kicker{font-size:21px;font-weight:700;letter-spacing:.02em;opacity:.85}
.cta-url{font-size:56px;font-weight:800;letter-spacing:-.02em;line-height:1.1;margin-top:2px}
.cta-phone{display:flex;align-items:center;gap:10px;font-size:25px;margin-top:10px}
.cta-phone span{font-size:19px;font-weight:500;opacity:.75;margin-left:6px}
.cta-qr{background:#fff;border-radius:18px;padding:14px 14px 8px;text-align:center;color:var(--navy);font-size:14px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.cta-qr svg{width:150px;height:150px;display:block}
.cta-qr div{margin-top:6px}

/* phone mockup */
.phone{width:340px;border-radius:46px;background:#05080F;padding:12px;box-shadow:0 40px 80px rgba(0,0,0,.55),0 0 0 2px #2A3650 inset}
.screen{border-radius:36px;background:#F1F5F9;overflow:hidden;color:var(--ink);height:100%}
.notch{width:110px;height:26px;border-radius:0 0 16px 16px;background:#05080F;margin:0 auto}
.app-bar{display:flex;align-items:center;justify-content:space-between;padding:10px 20px 12px}
.app-bar b{font-size:20px}
.app-bar .dot{width:34px;height:34px;border-radius:50%;background:var(--amber);display:grid;place-items:center;font-weight:800;font-size:14px;color:var(--navy)}
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:0 16px}
.tile{background:#fff;border-radius:16px;padding:12px 14px;box-shadow:0 1px 2px rgba(15,23,42,.06)}
.tile small{display:block;font-size:12px;color:#64748B;font-weight:500}
.tile b{font-size:26px;font-weight:800}
.card{background:#fff;border-radius:16px;padding:14px 16px;margin:10px 16px 0;box-shadow:0 1px 2px rgba(15,23,42,.06)}
.card h4{font-size:14px;font-weight:700;margin-bottom:8px}
.bar{display:flex;align-items:center;gap:10px;font-size:12.5px;margin:7px 0;color:#334155}
.bar span{width:84px;flex:none}
.bar i{flex:1;height:8px;border-radius:9px;background:#E2E8F0;position:relative;overflow:hidden}
.bar i::after{content:"";position:absolute;inset:0;width:var(--w);background:var(--c,var(--amber));border-radius:9px}
.bar em{font-style:normal;font-weight:700;width:38px;text-align:right}
.photo{height:92px;border-radius:12px;background:
  linear-gradient(160deg,rgba(11,18,32,.0),rgba(11,18,32,.55)),
  repeating-linear-gradient(90deg,#C08A3E 0 18px,#A8742F 18px 20px),
  linear-gradient(#7DB3E0,#B9D8F0 55%,#C08A3E 55%);position:relative}
.photo::before{content:"";position:absolute;left:18%;bottom:30%;width:46%;height:46%;border:5px solid #5B6B82;border-bottom:none;border-radius:2px}
.meta{display:flex;align-items:center;gap:6px;font-size:12px;color:#64748B;margin-top:8px}
.meta .ic{color:var(--amber)}

/* feature rows */
.feat{display:flex;align-items:center;gap:20px}
.feat .tilei{width:64px;height:64px;border-radius:18px;display:grid;place-items:center;background:rgba(245,158,11,.14);border:1.5px solid rgba(245,158,11,.35);color:var(--amber2);flex:none}
.feat b{display:block;font-size:26px;font-weight:700;line-height:1.2}
.feat small{display:block;font-size:20px;color:var(--muted);margin-top:3px;line-height:1.3}
`

const page = (title, body, cls = 'bg-dark') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=1080"><style>${CSS}</style></head>
<body><div class="flyer ${cls}">${body}</div></body></html>`

// --------------------------------------------------------------- flyers ----
const flyers = {}

// 1 - Brand / overview
flyers['01-run-every-site'] = page('VEXCORE - Run every site', `
<div class="stripe top"></div>
<div class="top-row">${brand()}</div>
<div class="kicker">CONSTRUCTION MANAGEMENT SOFTWARE</div>
<h1 style="font-size:86px">Run every site<br>from <span class="amber">one app.</span></h1>
<p class="lede" style="max-width:860px">Projects, workers, stock and daily site reports - all in one place, on any phone or computer.</p>
<div style="display:flex;gap:40px;margin-top:34px;align-items:flex-start">
  <div style="flex:1;display:flex;flex-direction:column;gap:26px;padding-top:8px">
    <div class="feat"><div class="tilei">${icon('camera', 32)}</div><div><b>Daily site reports</b><small>Photos, crew counts, time &amp; location</small></div></div>
    <div class="feat"><div class="tilei">${icon('qr', 32)}</div><div><b>QR attendance</b><small>Workers clock in, wages add up</small></div></div>
    <div class="feat"><div class="tilei">${icon('box', 32)}</div><div><b>Stock control</b><small>Every item issued is on record</small></div></div>
    <div class="feat"><div class="tilei">${icon('chart', 32)}</div><div><b>Budget vs actual</b><small>See spending per project</small></div></div>
  </div>
  <div class="phone" style="height:470px;transform:rotate(3deg);margin-right:6px">
    <div class="screen">
      <div class="notch"></div>
      <div class="app-bar"><b>Dashboard</b><div class="dot">JM</div></div>
      <div class="tiles">
        <div class="tile"><small>Active projects</small><b>3</b></div>
        <div class="tile"><small>Completion</small><b>68%</b></div>
      </div>
      <div class="card"><h4>Phase completion</h4>
        <div class="bar"><span>Foundation</span><i style="--w:100%;--c:#16A34A"></i><em>100%</em></div>
        <div class="bar"><span>Structure</span><i style="--w:72%"></i><em>72%</em></div>
        <div class="bar"><span>Roofing</span><i style="--w:38%"></i><em>38%</em></div>
      </div>
      <div class="card"><h4>Latest from the site</h4>
        <svg class="photo-svg" viewBox="0 0 280 100" width="100%" style="display:block;border-radius:12px">
          <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7FB6E6"/><stop offset="1" stop-color="#CFE5F6"/></linearGradient></defs>
          <rect width="280" height="100" fill="url(#sky)"/>
          <ellipse cx="60" cy="96" rx="140" ry="16" fill="#8FAE6B"/><rect y="86" width="280" height="14" fill="#B98E57"/>
          <g fill="#9AA6B8"><rect x="96" y="30" width="118" height="5"/><rect x="96" y="50" width="118" height="5"/><rect x="96" y="70" width="118" height="5"/></g>
          <g fill="#6B7A90"><rect x="98" y="30" width="6" height="56"/><rect x="136" y="30" width="6" height="56"/><rect x="172" y="30" width="6" height="56"/><rect x="206" y="30" width="6" height="56"/></g>
          <g fill="#C9A06A" opacity=".9"><rect x="104" y="57" width="32" height="13"/><rect x="142" y="57" width="30" height="13"/><rect x="178" y="77" width="28" height="9"/></g>
          <g stroke="#F59E0B" stroke-width="3" fill="none"><path d="M54 86V14"/><path d="M40 14h104"/><path d="M54 26 66 14"/><path d="M128 14v26"/></g>
          <rect x="122" y="40" width="12" height="7" fill="#F59E0B"/><rect x="44" y="80" width="20" height="6" fill="#475569"/>
        </svg>
        <div class="meta">${icon('pin', 14)} Kacyiru site · 18 builders · 16:40</div>
      </div>
    </div>
  </div>
</div>
${cta('amber')}
`)

// 2 - Problem / solution
const pairs = [
  ['Workers paid for days they weren\u2019t on site', 'Workers clock in and out with a QR card'],
  ['Cement and tools go missing - no record of who took them', 'Every item issued and returned by card scan'],
  ['Site photos lost in WhatsApp groups', 'Daily reports with photos, time and location'],
  ['Overspending found out at the end', 'Budget vs actual for every project, any time'],
]
flyers['02-paper-and-whatsapp'] = page('VEXCORE - Paper and WhatsApp', `
<div class="top-row">${brand('light')}</div>
<h1 style="font-size:84px;margin-top:52px;color:var(--ink)">Still running your sites on <span style="color:var(--amberD)">paper &amp; WhatsApp?</span></h1>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:0;margin-top:46px;border-radius:28px;overflow:hidden;box-shadow:0 24px 60px rgba(15,23,42,.14)">
  <div style="background:#fff;padding:26px 32px 10px"><div style="font-size:20px;font-weight:800;letter-spacing:.12em;color:#94A3B8">THE OLD WAY</div></div>
  <div style="background:var(--navy);padding:26px 32px 10px"><div style="font-size:20px;font-weight:800;letter-spacing:.12em;color:var(--amber2)">WITH VEXCORE</div></div>
  ${pairs.map(([bad, good], i) => `
  <div style="background:#fff;padding:20px 32px;display:flex;gap:16px;align-items:flex-start;${i ? 'border-top:1.5px solid #EEF2F7' : ''}">
    <span style="width:40px;height:40px;border-radius:12px;background:#FEE2E2;color:var(--red);display:grid;place-items:center;flex:none">${icon('x', 22, 3)}</span>
    <span style="font-size:24px;line-height:1.35;color:#334155">${bad}</span></div>
  <div style="background:var(--navy);padding:20px 32px;display:flex;gap:16px;align-items:flex-start;${i ? 'border-top:1.5px solid #1C2840' : ''}">
    <span style="width:40px;height:40px;border-radius:12px;background:rgba(22,163,74,.18);color:#4ADE80;display:grid;place-items:center;flex:none">${icon('check', 22, 3)}</span>
    <span style="font-size:24px;line-height:1.35;color:#fff;font-weight:500">${good}</span></div>`).join('')}
  <div style="background:#fff;height:22px"></div><div style="background:var(--navy);height:22px"></div>
</div>
${cta('navy', 'Switch in one afternoon - try it free for 14 days')}
`, 'bg-cream')

// 3 - Attendance & wages
const scans = [
  ['07:02', 'Jean Bosco', 'Builder'], ['07:05', 'Marie Claire', 'Helper'],
  ['07:09', 'Eric Niyonzima', 'Builder'], ['07:11', 'Aline Uwase', 'Helper'],
]
flyers['03-attendance-wages'] = page('VEXCORE - Attendance and wages', `
<div class="stripe top"></div>
<div class="top-row">${brand()}</div>
<div class="kicker">QR ATTENDANCE &amp; WAGES</div>
<h1 style="font-size:80px">Pay for days worked.<br><span class="amber">Not a franc more.</span></h1>
<div style="display:flex;gap:36px;margin-top:36px;align-items:stretch">
  <div style="width:300px;flex:none;border-radius:28px;background:#fff;color:var(--ink);overflow:hidden;box-shadow:0 30px 70px rgba(0,0,0,.45);transform:rotate(-3deg)">
    <div style="background:var(--amber);padding:18px 22px;display:flex;align-items:center;gap:12px">${MARK(38)}<div style="font-weight:800;letter-spacing:.14em;font-size:18px;color:var(--navy)">VEXCORE</div></div>
    <div style="padding:22px 24px 24px;text-align:center">
      <div style="width:84px;height:84px;border-radius:50%;margin:0 auto;background:#E2E8F0;display:grid;place-items:center;font-weight:800;font-size:34px;color:#475569">JB</div>
      <div style="font-weight:800;font-size:26px;margin-top:12px">Jean Bosco</div>
      <div style="font-size:16px;color:#64748B;font-weight:600;letter-spacing:.1em">BUILDER</div>
      <div style="width:150px;height:150px;margin:12px auto 0;padding:9px;border:2px solid #E2E8F0;border-radius:14px">${cardQr.replace('<svg', '<svg width="128" height="128"')}</div>
      <div style="font-size:13px;color:#94A3B8;margin-top:8px;letter-spacing:.12em">CARD W-0147</div>
    </div>
  </div>
  <div style="flex:1;display:flex;flex-direction:column;gap:12px">
    <div style="font-size:19px;font-weight:700;letter-spacing:.12em;color:var(--muted)">TODAY · KACYIRU SITE</div>
    ${scans.map(([t, n, r]) => `
    <div style="display:flex;align-items:center;gap:16px;background:var(--navy2);border:1.5px solid var(--line);border-radius:18px;padding:8px 18px">
      <span style="width:42px;height:42px;border-radius:12px;background:rgba(22,163,74,.18);color:#4ADE80;display:grid;place-items:center">${icon('check', 22, 3)}</span>
      <div style="flex:1"><div style="font-size:22px;font-weight:600">${n}</div><div style="font-size:16px;color:var(--muted)">${r} · clocked in</div></div>
      <div style="font-size:22px;font-weight:700;color:var(--amber2)">${t}</div>
    </div>`).join('')}
    <div style="display:flex;gap:14px;margin-top:4px">
      <div style="flex:1;background:var(--amber);color:var(--navy);border-radius:18px;padding:14px 18px"><div style="font-size:15px;font-weight:700;letter-spacing:.06em">ON SITE</div><div style="font-size:34px;font-weight:800">26</div></div>
      <div style="flex:1.4;background:var(--navy2);border:1.5px solid var(--line);border-radius:18px;padding:14px 18px"><div style="font-size:15px;font-weight:700;letter-spacing:.06em;color:var(--muted)">WAGES TODAY</div><div style="font-size:34px;font-weight:800">182,000 <span style="font-size:18px;color:var(--muted)">RWF</span></div></div>
    </div>
  </div>
</div>
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:26px 0 24px">
  ${[['print', 'Print QR ID cards', 'for every worker'], ['scan', 'Scan in &amp; out', 'with any smartphone'], ['cash', 'Wages calculated', 'from each daily rate']]
    .map(([ic, a, b], i) => `<div style="display:flex;gap:14px;align-items:center"><span style="width:52px;height:52px;border-radius:50%;background:var(--amber);color:var(--navy);display:grid;place-items:center;font-weight:800;font-size:22px;flex:none">${i + 1}</span><div><div style="font-size:22px;font-weight:700;line-height:1.2">${a}</div><div style="font-size:17px;color:var(--muted)">${b}</div></div></div>`).join('')}
</div>
${cta('amber')}
`)

// 4 - Stock control
const rows = [
  ['Cement 42.5N', 'Main store', '120 bags', 'ok'],
  ['Rebar Y12', 'Main store', '340 pcs', 'ok'],
  ['Shovels', 'Site B store', '14 pcs', 'ok'],
  ['Wheelbarrows', 'Site B store', '2 pcs', 'low'],
]
flyers['04-stock-control'] = page('VEXCORE - Stock control', `
<div style="position:absolute;inset:0 0 auto 0;height:640px;background:var(--amber)"></div>
<div style="position:absolute;inset:0 0 auto 0;height:640px;background:linear-gradient(rgba(11,18,32,.06) 1px,transparent 1px) 0 0/44px 44px,linear-gradient(90deg,rgba(11,18,32,.06) 1px,transparent 1px) 0 0/44px 44px"></div>
<div style="position:relative;display:flex;flex-direction:column;height:100%">
  <div class="top-row"><div class="brand light">${MARK(60, '#0B1220', '#F59E0B')}<div><div class="brand-name">VEXCORE</div><div class="brand-sub" style="color:#7C4A03">Construction Management</div></div></div></div>
  <div class="kicker" style="background:rgba(11,18,32,.1);border-color:rgba(11,18,32,.25);color:var(--navy)">STOCK &amp; STORES</div>
  <h1 style="font-size:90px;color:var(--navy)">Know where every<br>bag of cement goes.</h1>
  <div style="margin-top:44px;background:#fff;border-radius:28px;box-shadow:0 30px 70px rgba(11,18,32,.25);overflow:hidden;color:var(--ink)">
    <div style="display:flex;justify-content:space-between;align-items:center;padding:22px 30px;border-bottom:1.5px solid #EEF2F7">
      <div style="font-size:24px;font-weight:800">Stock · Kacyiru project</div>
      <div style="display:flex;align-items:center;gap:8px;font-size:17px;font-weight:700;color:var(--red);background:#FEE2E2;padding:6px 14px;border-radius:999px">${icon('bell', 18)} 1 low-stock alert</div>
    </div>
    ${rows.map(([n, s, q, st]) => `
    <div style="display:grid;grid-template-columns:1.4fr 1fr .8fr 92px;align-items:center;padding:15px 30px;border-bottom:1.5px solid #F1F5F9;font-size:21px">
      <b style="font-weight:700">${n}</b><span style="color:#64748B">${s}</span><b style="font-weight:700">${q}</b>
      <span style="justify-self:end;font-size:15px;font-weight:800;letter-spacing:.06em;padding:5px 12px;border-radius:999px;${st === 'low' ? 'background:#FEE2E2;color:#B91C1C' : 'background:#DCFCE7;color:#15803D'}">${st === 'low' ? 'LOW' : 'OK'}</span>
    </div>`).join('')}
    <div style="display:flex;align-items:center;gap:12px;padding:16px 30px;background:#FFFBEB;font-size:19px;color:#92400E">${icon('scan', 22)} <span><b>2 shovels</b> issued to <b>Jean Bosco</b> by card scan · 07:24</span></div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:22px 30px;margin:40px 0 36px;color:var(--ink)">
    ${[['box', 'A store per site, with its own manager'], ['scan', 'Issue and take back items by card scan'], ['swap', 'Transfers between stores need approval'], ['bell', 'Low-stock alerts before work stops']]
      .map(([ic, t]) => `<div style="display:flex;gap:14px;align-items:center;font-size:23px;font-weight:600;line-height:1.3"><span style="width:52px;height:52px;border-radius:15px;background:var(--navy);color:var(--amber);display:grid;place-items:center;flex:none">${icon(ic, 26)}</span>${t}</div>`).join('')}
  </div>
  ${cta('navy')}
</div>
`, 'bg-cream')

// 5 - Pricing / free trial
const plans = [
  ['Starter', '30,000', '1 active project', false],
  ['Pro', '80,000', 'Up to 5 active projects', true],
  ['Enterprise', '100,000', 'Unlimited projects', false],
]
flyers['05-pricing-free-trial'] = page('VEXCORE - Pricing', `
<div class="stripe top"></div>
<div class="top-row">${brand()}</div>
<div class="kicker">SIMPLE, AFFORDABLE PRICING</div>
<h1 style="font-size:88px">Start free for<br><span class="amber">14 days.</span></h1>
<p class="lede">No card required. Every plan includes <b style="color:#fff;font-weight:600">every feature</b> and <b style="color:#fff;font-weight:600">unlimited team members.</b></p>
<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:32px;align-items:end">
  ${plans.map(([n, p, l, hi]) => `
  <div style="border-radius:26px;padding:${hi ? '0' : '26px 24px'};${hi ? 'background:var(--amber);color:var(--navy);box-shadow:0 26px 60px rgba(245,158,11,.28)' : 'background:var(--navy2);border:1.5px solid var(--line)'}">
    ${hi ? `<div style="text-align:center;font-size:15px;font-weight:800;letter-spacing:.14em;padding:10px 0 0">FOR GROWING FIRMS</div><div style="padding:14px 24px 26px">` : ''}
      <div style="font-size:26px;font-weight:800">${n}</div>
      <div style="font-size:50px;font-weight:800;letter-spacing:-.02em;line-height:1.1;margin-top:10px">${p}</div>
      <div style="font-size:17px;font-weight:600;${hi ? '' : 'color:var(--muted)'}">RWF / month</div>
      <div style="margin-top:16px;padding-top:14px;border-top:1.5px solid ${hi ? 'rgba(11,18,32,.18)' : 'var(--line)'};font-size:19px;font-weight:600">${l}</div>
    ${hi ? '</div>' : ''}
  </div>`).join('')}
</div>
<div style="margin:28px 0 28px">
  <div style="font-size:19px;font-weight:700;letter-spacing:.12em;color:var(--muted);margin-bottom:16px">INCLUDED IN EVERY PLAN</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px 28px">
    ${['Daily site reports with photos', 'QR attendance &amp; wages', 'Stock, stores &amp; transfers', 'Budget vs actual reports', 'Documents &amp; drawings', 'Team chat &amp; access roles']
      .map(t => `<div style="display:flex;gap:12px;align-items:center;font-size:22px"><span style="color:var(--amber)">${icon('check', 24, 3)}</span>${t}</div>`).join('')}
  </div>
</div>
${cta('amber', 'Create your free account')}
`)

// --------------------------------------------------------------- output ----
const htmlDir = path.join(here, 'html'), pngDir = path.join(here, 'png')
fs.mkdirSync(htmlDir, { recursive: true }); fs.mkdirSync(pngDir, { recursive: true })

const browsers = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
]
const browser = browsers.find(b => fs.existsSync(b))
if (!browser) throw new Error('No Edge/Chrome found to render the flyers')

for (const [name, html] of Object.entries(flyers)) {
  const htmlPath = path.join(htmlDir, `${name}.html`)
  const pngPath = path.join(pngDir, `vexcore-${name}.png`)
  fs.writeFileSync(htmlPath, html)
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--window-size=1080,1350', '--virtual-time-budget=10000', '--run-all-compositor-stages-before-draw',
    `--screenshot=${pngPath}`, 'file:///' + htmlPath.replace(/\\/g, '/'),
  ], { stdio: 'ignore' })
  console.log('  rendered', path.relative(process.cwd(), pngPath))
}
