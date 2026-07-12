import { Mail, Phone, MapPin, Clock } from 'lucide-react'
import { PubNav, PubFoot } from './GetStarted.jsx'

export default function Support() {
  return (
    <div className="public">
      <PubNav />
      <div className="auth-wrap">
        <div className="auth-card" style={{ maxWidth: 520 }}>
          <h2>Support</h2>
          <p className="sub muted small">We usually respond within one business day.</p>
          <div className="small" style={{ lineHeight: 2.2 }}>
            <div><Mail size={14} /> <b>Email:</b> support@bridge.app</div>
            <div><Phone size={14} /> <b>Phone / WhatsApp:</b> +250 788 000 000</div>
            <div><MapPin size={14} /> <b>Office:</b> Kigali, Rwanda</div>
            <div><Clock size={14} /> <b>Hours:</b> Mon–Sat, 08:00–18:00 CAT</div>
          </div>
        </div>
      </div>
      <PubFoot />
    </div>
  )
}
