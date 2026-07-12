import { Link } from 'react-router-dom'
import { PubNav, PubFoot } from './GetStarted.jsx'

const TIERS = [
  { name: 'Starter', price: '30,000 RWF', per: '/month', bullet: ['1 active project', 'Senior Engineer working solo', 'Daily updates & phase tracking', 'Stock management'], cta: 'Start Trial' },
  { name: 'Pro', price: '80,000 RWF', per: '/month', highlight: true, bullet: ['Up to 5 active projects', 'Full team: site engineers, stock manager, guests', 'Budget vs actual + variance alerts', 'Chat with attachments', 'PDF reports'], cta: 'Start Trial' },
  { name: 'Enterprise', price: 'Custom', per: '', bullet: ['Unlimited projects', 'Custom branding', 'Priority support', 'MTN MoMo / Airtel / card billing'], cta: 'Contact us' },
]

export default function Pricing() {
  return (
    <div className="public">
      <PubNav />
      <div className="features" style={{ paddingTop: 60 }}>
        <h1 style={{ textAlign: 'center', fontSize: 30, marginBottom: 8 }}>Simple pricing, local payments</h1>
        <p className="muted" style={{ textAlign: 'center', marginBottom: 36 }}>
          14-day free trial on every plan. Your account activates automatically when you subscribe.
        </p>
        <div className="grid grid-3">
          {TIERS.map((t) => (
            <div className="card" key={t.name} style={t.highlight ? { border: '2px solid var(--accent)' } : {}}>
              {t.highlight && <span className="badge amber" style={{ marginBottom: 10, display: 'inline-block' }}>Most popular</span>}
              <div className="feat-title" style={{ fontSize: 17 }}>{t.name}</div>
              <div style={{ margin: '8px 0 16px' }}>
                <span style={{ fontSize: 26, fontWeight: 800 }}>{t.price}</span>
                <span className="muted small">{t.per}</span>
              </div>
              <div className="small" style={{ lineHeight: 2 }}>
                {t.bullet.map((b) => <div key={b}>✓ {b}</div>)}
              </div>
              <Link to={t.name === 'Enterprise' ? '/support' : '/signup'} className="btn" style={{ marginTop: 16, width: '100%', justifyContent: 'center' }}>
                {t.cta}
              </Link>
            </div>
          ))}
        </div>
      </div>
      <PubFoot />
    </div>
  )
}
