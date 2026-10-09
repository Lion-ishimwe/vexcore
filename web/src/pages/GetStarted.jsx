import { Link, useNavigate, useLocation } from 'react-router-dom'
import {
  ClipboardList, Wallet, Package, Users, Camera, FileText,
  Building2, HardHat, Hammer, DraftingCompass, Monitor, Smartphone,
  MessagesSquare, Lock, MapPin,
} from 'lucide-react'

export function PubNav() {
  const nav = useNavigate()
  const loc = useLocation()
  const goFeatures = (e) => {
    e.preventDefault()
    if (loc.pathname !== '/') nav('/')
    setTimeout(() => document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' }), 60)
  }
  return (
    <nav className="mk-nav">
      <Link to="/" className="mk-brand">
        <img className="logo-mark" src="/logo.png" alt="VEXCORE logo" />
        <div>
          <div className="logo-name" style={{ color: 'var(--text)' }}>VEXCORE</div>
          <div className="logo-sub">Construction Management System</div>
        </div>
      </Link>
      <div className="mk-links">
        <a href="#features" onClick={goFeatures}>Features</a>
        <Link to="/pricing">Pricing</Link>
        <Link to="/support">Support</Link>
      </div>
      <div className="mk-nav-cta">
        <Link to="/login" className="mk-login">Login</Link>
        <Link to="/signup" className="btn">Try For Free</Link>
      </div>
    </nav>
  )
}

export function PubFoot() {
  return (
    <footer className="mk-foot">
      <div className="mk-foot-grid">
        <div>
          <div className="mk-brand" style={{ marginBottom: 12 }}>
            <img className="logo-mark" src="/logo.png" alt="VEXCORE logo" />
            <div className="logo-name" style={{ color: '#fff' }}>VEXCORE</div>
          </div>
          <p>One place to plan projects, track daily progress, manage stock, and control spending - built for construction teams in East Africa.</p>
        </div>
        <div>
          <h5>Get in touch</h5>
          <a href="mailto:support@bridge.app">support@bridge.app</a>
          <a href="tel:+250785576541">+250 785 576 541</a>
          <span>Kigali, Rwanda</span>
        </div>
        <div>
          <h5>Explore</h5>
          <Link to="/pricing">Pricing</Link>
          <Link to="/support">Support</Link>
          <Link to="/login">Login</Link>
          <Link to="/signup">Start free trial</Link>
        </div>
        <div>
          <h5>Product</h5>
          <span>Daily site updates</span>
          <span>Phase cost tracking</span>
          <span>Stock &amp; inventory</span>
          <span>Reports &amp; audit trail</span>
        </div>
      </div>
      <div className="mk-foot-base">© 2026 VEXCORE · Construction Management System · All rights reserved</div>
    </footer>
  )
}

function HeroMock() {
  return (
    <div className="mock-window" aria-hidden="true">
      <div className="mock-title">
        <span /><span /><span />
        <b>VEXCORE - Dashboard</b>
      </div>
      <div className="mock-body">
        <div className="mock-side">
          <div className="mock-logo" />
          {[52, 40, 46, 40, 34, 40].map((w, i) => (
            <div className={`mock-navitem ${i === 0 ? 'on' : ''}`} key={i} style={{ width: `${w + 26}%` }} />
          ))}
        </div>
        <div className="mock-main">
          <div className="mock-cards">
            <div className="mock-card"><i>Active projects</i><b>2</b></div>
            <div className="mock-card"><i>Completion</i><b>44%</b></div>
            <div className="mock-card"><i>Spend to date</i><b>125.9M</b></div>
          </div>
          <div className="mock-panel">
            <i>Phase completion</i>
            {[100, 72, 100, 12, 0].map((p, i) => (
              <div className="mock-bar" key={i}><span style={{ width: `${p}%`, background: p === 100 ? '#16a34a' : 'var(--accent)' }} /></div>
            ))}
          </div>
          <div className="mock-row">
            <div className="mock-panel" style={{ flex: 1 }}>
              <i>Latest from the field</i>
              <div className="mock-feed"><em>JK</em><span>18 builders · 26 helpers · 4 photos</span></div>
              <div className="mock-feed"><em>AI</em><span>Roofing signed off ✓ photo proof</span></div>
            </div>
            <div className="mock-donut">
              <svg viewBox="0 0 80 80" width="86" height="86">
                <circle cx="40" cy="40" r="32" fill="none" stroke="#eef0f3" strokeWidth="9" />
                <circle cx="40" cy="40" r="32" fill="none" stroke="#f59e0b" strokeWidth="9"
                  strokeDasharray="88 201" strokeLinecap="round" transform="rotate(-90 40 40)" />
              </svg>
              <b>44%</b>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function FlowSection() {
  return (
    <section className="flow">
      <h2>From the drawing board to the site - and back</h2>
      <p className="mk-section-sub">
        The design on a tablet, the project in the system, the daily proof from a phone - one connected flow.
      </p>

      <div className="comp" aria-hidden="true">

        {/* Desktop - the system (back layer) */}
        <div className="comp-desktop">
          <div className="comp-top">
            <span /><span /><span />
            <b>VEXCORE - Dashboard</b>
            <i>EM</i>
          </div>
          <div className="comp-body">
            <div className="comp-side">
              <div className="mock-logo" />
              {[68, 52, 60, 52, 44, 52].map((w, i) => (
                <div className={`mock-navitem ${i === 0 ? 'on' : ''}`} key={i} style={{ width: `${w}%` }} />
              ))}
            </div>
            <div className="comp-main">
              <div className="comp-stats">
                <div className="comp-stat"><i>Active projects</i><b>2</b></div>
                <div className="comp-stat"><i>Overall completion</i><b>44%</b></div>
                <div className="comp-stat"><i>Spend to date</i><b>125.9M <u>RWF</u></b></div>
              </div>
              <div className="comp-panels">
                <div className="comp-panel">
                  <i>Phase completion</i>
                  {[
                    ['Foundation', 100], ['Structure & Columns', 72], ['Roofing', 100], ['Electrical', 12],
                  ].map(([n, p]) => (
                    <div className="comp-barrow" key={n}>
                      <span>{n}</span>
                      <div className="mock-bar"><span style={{ width: `${p}%`, background: p === 100 ? '#16a34a' : 'var(--accent)' }} /></div>
                      <b>{p}%</b>
                    </div>
                  ))}
                </div>
                <div className="comp-panel">
                  <i>Latest from the field</i>
                  <div className="comp-feed"><em>JK</em><span>18 builders · 26 helpers · slab poured</span></div>
                  <div className="comp-feed"><em>AI</em><span>Roofing signed off · photo proof ✓</span></div>
                  <div className="comp-thumbs">
                    <div /><div className="a" /><div className="b" /><div className="c" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Tablet - the design (front right) */}
        <div className="comp-tablet">
          <div className="comp-tab-screen">
            <svg viewBox="0 0 250 320">
              <defs>
                <pattern id="bpgrid2" width="12" height="12" patternUnits="userSpaceOnUse">
                  <path d="M 12 0 L 0 0 0 12" fill="none" stroke="rgba(255,255,255,.12)" strokeWidth="1" />
                </pattern>
              </defs>
              <rect width="250" height="320" fill="#1e3a8a" />
              <rect width="250" height="320" fill="url(#bpgrid2)" />
              <text x="20" y="26" fill="rgba(255,255,255,.9)" fontSize="10" fontFamily="monospace">BLOCK A - GROUND FLOOR</text>
              <text x="20" y="38" fill="rgba(255,255,255,.5)" fontSize="7" fontFamily="monospace">SCALE 1:100 · REV 3</text>
              {/* outer walls */}
              <rect x="28" y="52" width="194" height="216" fill="none" stroke="#fff" strokeWidth="2.6" />
              {/* rooms */}
              <line x1="28" y1="140" x2="130" y2="140" stroke="#fff" strokeWidth="1.5" />
              <line x1="130" y1="52" x2="130" y2="180" stroke="#fff" strokeWidth="1.5" />
              <line x1="130" y1="180" x2="222" y2="180" stroke="#fff" strokeWidth="1.5" />
              <line x1="90" y1="140" x2="90" y2="268" stroke="#fff" strokeWidth="1.5" />
              {/* door arcs */}
              <path d="M 130 158 A 18 18 0 0 0 112 140" fill="none" stroke="rgba(255,255,255,.85)" strokeWidth="1.2" />
              <path d="M 90 200 A 16 16 0 0 1 106 184" fill="none" stroke="rgba(255,255,255,.85)" strokeWidth="1.2" />
              {/* windows */}
              <line x1="50" y1="52" x2="80" y2="52" stroke="#fbbf24" strokeWidth="4.5" />
              <line x1="150" y1="268" x2="184" y2="268" stroke="#fbbf24" strokeWidth="4.5" />
              <line x1="222" y1="90" x2="222" y2="118" stroke="#fbbf24" strokeWidth="4.5" />
              {/* labels */}
              <text x="48" y="100" fill="rgba(255,255,255,.8)" fontSize="8.5" fontFamily="monospace">LOUNGE</text>
              <text x="152" y="110" fill="rgba(255,255,255,.8)" fontSize="8.5" fontFamily="monospace">BEDROOM 1</text>
              <text x="42" y="210" fill="rgba(255,255,255,.8)" fontSize="8.5" fontFamily="monospace">KITCHEN</text>
              <text x="146" y="230" fill="rgba(255,255,255,.8)" fontSize="8.5" fontFamily="monospace">BATH</text>
              {/* dimension line */}
              <line x1="28" y1="284" x2="222" y2="284" stroke="rgba(255,255,255,.55)" strokeWidth="1" />
              <line x1="28" y1="280" x2="28" y2="288" stroke="rgba(255,255,255,.55)" strokeWidth="1" />
              <line x1="222" y1="280" x2="222" y2="288" stroke="rgba(255,255,255,.55)" strokeWidth="1" />
              <text x="108" y="296" fill="rgba(255,255,255,.7)" fontSize="8" fontFamily="monospace">12.40 m</text>
              {/* red-pen site markup */}
              <path d="M 60 305 C 100 300 120 260 128 205" fill="none" stroke="#fb7185" strokeWidth="2" strokeLinecap="round" strokeDasharray="1 0" />
              <path d="M 124 216 l 4 -13 l 9 9" fill="none" stroke="#fb7185" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <text x="18" y="315" fill="#fb7185" fontSize="15" fontFamily="Caveat, cursive" fontWeight="700">reinforce column C4</text>
              <circle cx="130" cy="180" r="9" fill="none" stroke="#fb7185" strokeWidth="1.8" />
            </svg>
          </div>
        </div>

        {/* Phone - the site (front left) */}
        <div className="flow-phone comp-phone">
          <div className="flow-notch" />
          <div className="flow-screen">
            <div className="flow-ph-head">
              <b>Daily update</b>
              <span className="flow-sync">● synced</span>
            </div>
            <div className="flow-photos">
              <div className="flow-photo" /><div className="flow-photo p2" />
              <div className="flow-photo p3" /><div className="flow-photo plus">+2</div>
            </div>
            <div className="flow-count"><span><HardHat size={11} /> Builders</span><b>18</b></div>
            <div className="flow-count"><span><Users size={11} /> Helpers</span><b>26</b></div>
            <div className="flow-geo"><MapPin size={9} /> Kacyiru site · 16:40</div>
            <div className="flow-send">Submit update</div>
          </div>
        </div>

        <span className="comp-tag t-design"><DraftingCompass size={14} /> The design</span>
        <span className="comp-tag t-system"><Monitor size={14} /> The system</span>
        <span className="comp-tag t-site"><Smartphone size={14} /> The site</span>
      </div>

      <div className="comp-legend">
        <div className="flow-caption">
          <b><DraftingCompass size={16} /> The design</b>
          <span>Drawings, BOQ and permits live on the project - marked up on site, never lost.</span>
        </div>
        <div className="flow-caption">
          <b><Monitor size={16} /> The system</b>
          <span>The office runs phases, budgets and stock - every franc accounted for.</span>
        </div>
        <div className="flow-caption">
          <b><Smartphone size={16} /> The site</b>
          <span>Field teams log workers and photos in under two minutes - proof, not promises.</span>
        </div>
      </div>
    </section>
  )
}

const FEATURES = [
  {
    icon: ClipboardList, title: 'Project Management',
    items: ['Phases & tasks on a Kanban board', 'Timelines & assignments', 'Photo proof to close a phase', 'Project documents & designs'],
  },
  {
    icon: Wallet, title: 'Financials',
    items: ['Phase-level budgets', 'Labor cost from daily headcounts', 'Materials drawn from stock', 'Budget vs actual with variance'],
  },
  {
    icon: Package, title: 'Stock & Inventory',
    items: ['Consumables & machines (serials)', 'Low-stock alerts', 'Request → approval flow', 'Damaged-item tracking'],
  },
  {
    icon: Users, title: 'People & Roles',
    items: ['Client, engineers, stock manager, guests', 'Clear chain of responsibility', 'Permission toggles per feature', 'Company chat'],
  },
  {
    icon: Camera, title: 'Daily Site Updates',
    items: ['Worker counts in seconds', 'Photos & videos from the field', 'Auto-timestamped & geotagged', 'Forwarded to the client'],
  },
  {
    icon: FileText, title: 'Reports & Audit',
    items: ['Itemized phase reports', 'Bank-ready budget summaries', 'Full audit trail of every action', 'Print / PDF export'],
  },
]

const ROLES = [
  { icon: Building2, name: 'Clients & Owners', text: 'See real progress and real spend without calling the site.' },
  { icon: HardHat, name: 'Senior Engineers', text: 'Run one project or ten - solo or with a full site team.' },
  { icon: Hammer, name: 'Site Engineers', text: 'Log the day in under two minutes, straight from the site.' },
  { icon: Package, name: 'Stock Managers', text: 'Track quantities and request materials - amounts stay private.' },
]

export default function GetStarted() {
  return (
    <div className="public mk">
      <PubNav />

      <header className="mk-hero">
        <div className="mk-hero-inner">
          <div className="mk-hero-copy">
            <span className="mk-eyebrow">All-in-one construction management</span>
            <h1>Easy, affordable construction management software</h1>
            <p className="mk-sub">
              Plan projects, track daily progress from the site, manage stock, and control
              spending phase by phase - with your whole team on the same page.
            </p>
            <div className="mk-price-line">
              <b>From 30,000 RWF/month</b>
              <span>·</span> 14-day free trial
              <span>·</span> No card required
            </div>
            <div className="mk-cta">
              <Link to="/signup" className="btn big">Try For Free</Link>
              <Link to="/demo" className="btn big ghost">Book a Demo</Link>
            </div>
            <div className="mk-trust">
              <span className="mk-stars">★★★★★</span>
              Built with site teams in Kigali - designed for how projects actually run.
            </div>
          </div>
          <HeroMock />
        </div>
      </header>

      <section className="mk-band">
        <div className="mk-band-inner">
          <div><b>6 roles</b><span>one clear chain of command</span></div>
          <div><b>Phase-level</b><span>budgets, costs & variance</span></div>
          <div><b>Photo proof</b><span>required before sign-off</span></div>
          <div><b>Isolated data</b><span>per company, audit-trailed</span></div>
        </div>
      </section>

      <FlowSection />

      <section className="mk-section" id="features">
        <h2>Everything your project needs, in one place</h2>
        <p className="mk-section-sub">No more juggling WhatsApp photos, Excel budgets, and paper stock books.</p>
        <div className="mk-feat-grid">
          {FEATURES.map((f) => (
            <div className="mk-feat" key={f.title}>
              <div className="mk-feat-icon"><f.icon size={22} /></div>
              <h3>{f.title}</h3>
              <ul>{f.items.map((i) => <li key={i}>{i}</li>)}</ul>
            </div>
          ))}
        </div>
      </section>

      <section className="mk-section alt">
        <h2>Created for construction teams, by people on site</h2>
        <p className="mk-section-sub">Every role sees exactly what they need - nothing more, nothing less.</p>
        <div className="mk-role-grid">
          {ROLES.map((r) => (
            <div className="mk-role" key={r.name}>
              <div className="mk-feat-icon"><r.icon size={22} /></div>
              <h4>{r.name}</h4>
              <p>{r.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mk-dark">
        <div className="mk-dark-inner">
          <div><b><MessagesSquare size={26} /></b><h4>Local support</h4><p>Real people in Kigali, on WhatsApp and phone - in your timezone.</p></div>
          <div><b><Smartphone size={26} /></b><h4>Mobile money ready</h4><p>MTN MoMo and Airtel Money billing on the roadmap - priced locally.</p></div>
          <div><b><Lock size={26} /></b><h4>Your data, isolated</h4><p>Every company's data is fully separated, permission-gated, and audit-trailed.</p></div>
          <div><b><FileText size={26} /></b><h4>Bank-ready reports</h4><p>Hand clean progress and cost reports to owners, banks, or investors.</p></div>
        </div>
      </section>

      <section className="mk-final">
        <h2>Start your first project today</h2>
        <p>14-day free trial · full access · cancel anytime</p>
        <div className="mk-cta" style={{ justifyContent: 'center' }}>
          <Link to="/signup" className="btn big">Start Free Trial</Link>
          <Link to="/pricing" className="btn big outline-dark">See Pricing</Link>
        </div>
      </section>

      <PubFoot />
    </div>
  )
}
