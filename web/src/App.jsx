import { useEffect, useState } from 'react'
import { Routes, Route, NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, Building2, ClipboardList, Camera, Package, MessageSquare,
  Users, FileText, Settings as SettingsIcon, Shield, LogOut, FolderOpen, UserCheck,
  Menu, Plus, X, CreditCard, CalendarDays,
} from 'lucide-react'
import { useAuth } from './auth.jsx'
import { useT, LanguagePicker } from './i18n.jsx'
import { WeatherWidget } from './weather.jsx'
import GetStarted from './pages/GetStarted.jsx'
import Pricing from './pages/Pricing.jsx'
import Support from './pages/Support.jsx'
import Demo from './pages/Demo.jsx'
import Login from './pages/Login.jsx'
import Signup from './pages/Signup.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Projects from './pages/Projects.jsx'
import Kanban from './pages/Kanban.jsx'
import PhaseReport from './pages/PhaseReport.jsx'
import Schedule from './pages/Schedule.jsx'
import Updates from './pages/Updates.jsx'
import Documents from './pages/Documents.jsx'
import Attendance from './pages/Attendance.jsx'
import Kiosk from './pages/Kiosk.jsx'
import Stock from './pages/Stock.jsx'
import Chat from './pages/Chat.jsx'
import Reports from './pages/Reports.jsx'
import Settings from './pages/Settings.jsx'
import Billing from './pages/Billing.jsx'
import Team from './pages/Team.jsx'
import Admin from './pages/Admin.jsx'
import Companies from './pages/Companies.jsx'
import Demos from './pages/Demos.jsx'
import Payments from './pages/Payments.jsx'
import AdminSettings from './pages/AdminSettings.jsx'
import Account from './pages/Account.jsx'
import { api, setToken, fmtDate, fmtDay } from './api.js'
import { Modal } from './ui.jsx'

const NAV = [
  { to: '/', icon: LayoutDashboard, key: 'nav.dashboard', cap: 'dashboard' },
  { to: '/projects', icon: Building2, key: 'nav.projects', cap: 'projects.view' },
  { to: '/phases', icon: ClipboardList, key: 'nav.phases', cap: 'phases.view' },
  { to: '/schedule', icon: CalendarDays, key: 'Schedule', cap: 'schedule.view' },
  { to: '/updates', icon: Camera, key: 'nav.updates', cap: 'updates.view' },
  { to: '/documents', icon: FolderOpen, key: 'nav.documents', cap: 'docs.view' },
  { to: '/attendance', icon: UserCheck, key: 'nav.attendance', cap: 'attendance.view' },
  { to: '/stock', icon: Package, key: 'nav.stock', cap: 'stock.view' },
  { to: '/chat', icon: MessageSquare, key: 'nav.chat', cap: 'chat' },
  { to: '/team', icon: Users, key: 'nav.team', cap: 'team.view' },
  { to: '/reports', icon: FileText, key: 'nav.reports', cap: 'reports' },
  { to: '/settings', icon: SettingsIcon, key: 'nav.settings', cap: 'settings.edit' },
  { to: '/billing', icon: CreditCard, key: 'nav.billing', cap: 'billing' },
]

const TITLE_KEYS = {
  '/': 'nav.dashboard', '/projects': 'nav.projects', '/phases': 'nav.phases', '/schedule': 'Schedule',
  '/updates': 'nav.updates', '/documents': 'nav.documents', '/attendance': 'nav.attendance',
  '/stock': 'nav.stock', '/chat': 'nav.chat', '/team': 'nav.team', '/reports': 'nav.reports',
  '/settings': 'nav.settings', '/billing': 'nav.billing',
  '/admin': 'Platform Dashboard', '/admin/companies': 'Companies', '/admin/demos': 'Demo Bookings',
  '/admin/payments': 'Subscription Payments', '/admin/settings': 'Settings', '/account': 'nav.account',
}

// Bottom navigation for phones: the four everyday destinations + the amber
// "new daily update" action in the middle.
const MOBILE_SLOTS = [
  { to: '/', icon: LayoutDashboard, key: 'nav.home', cap: 'dashboard' },
  { to: '/phases', icon: ClipboardList, key: 'nav.phases', cap: 'phases.view' },
  { fab: true, cap: 'updates.submit' },
  { to: '/attendance', icon: UserCheck, key: 'nav.attendance', cap: 'attendance.view' },
  { to: '/chat', icon: MessageSquare, key: 'nav.chat', cap: 'chat' },
]

const ROLE_LABEL = {
  SUPER: 'Super Admin', CLIENT: 'Admin', SENIOR: 'Senior Engineer',
  SITE: 'Site Engineer', STOCK: 'Stock Manager', GUEST: 'Guest',
}

// Super Admin popup: new demo bookings from the public site ping here (polled
// every 30s) and stay until acknowledged - full details, nothing missed.
function DemoAlerts() {
  const [alerts, setAlerts] = useState([])
  useEffect(() => {
    let on = true
    const load = () => api('/admin/demo-alerts').then((a) => { if (on) setAlerts(a) }).catch(() => {})
    load()
    const t = setInterval(load, 30000)
    return () => { on = false; clearInterval(t) }
  }, [])
  if (!alerts.length) return null
  const dismiss = async () => {
    try { await api('/admin/demo-alerts/seen', { method: 'POST', body: { ids: alerts.map((a) => a.id) } }) }
    catch { /* still unseen server-side - it will pop again on the next poll */ }
    setAlerts([])
  }
  return (
    <Modal title={`🔔 New demo booking${alerts.length === 1 ? '' : 's'} (${alerts.length})`} onClose={dismiss}>
      {alerts.map((b) => (
        <div key={b.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', marginBottom: 10 }}>
          <b style={{ fontSize: 14.5 }}>{b.name}{b.company ? ` · ${b.company}` : ''}</b>
          <div className="small" style={{ marginTop: 6, display: 'grid', gap: 3 }}>
            <span><b>Demo slot:</b> {fmtDate(b.slot)}</span>
            <span><b>Email:</b> {b.email}</span>
            {b.phone && <span><b>Phone:</b> {b.phone}</span>}
            {b.teamSize && <span><b>Team size:</b> {b.teamSize}</span>}
            {(b.interests ?? []).length > 0 && <span><b>Interested in:</b> {b.interests.join(', ')}</span>}
            <span className="muted">Booked {fmtDate(b.createdAt)}</span>
          </div>
        </div>
      ))}
      <button className="btn" style={{ width: '100%', justifyContent: 'center' }} onClick={dismiss}>
        Got it - mark as seen
      </button>
    </Modal>
  )
}

function trialLabel(client) {
  if (!client) return null
  if (client.status === 'TRIAL' && client.trialEndsAt) {
    const days = Math.max(0, Math.ceil((new Date(client.trialEndsAt) - Date.now()) / 86400000))
    return `Trial - ${days} day${days === 1 ? '' : 's'} left`
  }
  return client.status === 'ACTIVE' ? 'Subscribed' : client.status
}

export default function App() {
  const { user, client, subscription, impersonating, can, loading, logout } = useAuth()

  // Leave support mode: restore the parked Super Admin token.
  const exitSupport = () => {
    const sup = localStorage.getItem('bridge_super_token')
    localStorage.removeItem('bridge_super_token')
    setToken(sup ?? null)
    window.location.hash = '#/admin/companies'
    window.location.reload()
  }
  const { t } = useT()
  const loc = useLocation()
  const nav2 = useNavigate()
  const [moreOpen, setMoreOpen] = useState(false)

  if (loading) return <div className="locked"><h2>{t('common.loading')}</h2></div>

  if (!user) {
    return (
      <Routes>
        <Route path="/" element={<GetStarted />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/support" element={<Support />} />
        <Route path="/demo" element={<Demo />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    )
  }

  const isSuper = user.role === 'SUPER'

  // Kiosk renders fullscreen, without the app shell - it's a gate screen.
  if (!isSuper && loc.pathname.startsWith('/kiosk/') && can('attendance.record')) {
    return (
      <Routes>
        <Route path="/kiosk/:id" element={<Kiosk />} />
        <Route path="*" element={<Navigate to="/attendance" />} />
      </Routes>
    )
  }

  const nav = isSuper
    ? [
        { to: '/admin', icon: LayoutDashboard, label: 'Dashboard', cap: null },
        { to: '/admin/companies', icon: Building2, label: 'Companies', cap: null },
        { to: '/admin/payments', icon: CreditCard, label: 'Payments', cap: null },
        { to: '/admin/demos', icon: CalendarDays, label: 'Demos', cap: null },
        { to: '/admin/settings', icon: SettingsIcon, label: 'Settings', cap: null },
      ]
    : NAV.filter((n) => can(n.cap))

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          <img className="logo-mark" src="/logo.png" alt="Bridge logo" />
          <div>
            <div className="logo-name">Bridge</div>
            <div className="logo-sub">{isSuper ? 'Platform operator' : client?.company}</div>
          </div>
        </div>
        <nav className="nav">
          <div className="nav-section">{isSuper ? 'Platform' : 'Workspace'}</div>
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/' || n.to === '/admin'}
              className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="icon"><n.icon size={16} /></span> {n.label ?? t(n.key)}
            </NavLink>
          ))}
        </nav>
        {!isSuper && (
          <div className="sidebar-foot">
            Currency: <b>{client?.currency}</b>
          </div>
        )}
      </aside>

      <div className="main">
        {impersonating && (
          <div className="support-bar no-print">
            <Shield size={13} />
            <span>Support mode - you are acting as the admin of <b>{impersonating.company}</b></span>
            <button className="btn sm" onClick={exitSupport}>Exit support</button>
          </div>
        )}
        <header className="topbar">
          <button className="hamb mobile-only" onClick={() => setMoreOpen(true)} aria-label={t('nav.more')}>
            <Menu size={19} />
          </button>
          <h1>{(() => { const k = TITLE_KEYS[loc.pathname]; return k ? (k.includes('.') ? t(k) : k) : 'Bridge' })()}</h1>
          <div className="topbar-right">
            {!isSuper && <WeatherWidget />}
            {!isSuper && <span className="trial-chip desk-only">{trialLabel(client)}</span>}
            {/* Accounts live inside Settings: /admin/settings for the platform
                operator, /settings (My Account / Security tabs) for client admins */}
            <NavLink to={isSuper ? '/admin/settings' : can('settings.edit') ? '/settings' : '/account'}
              className="account-link" title={t('nav.account')}>
              <span className="small muted desk-only">{user.name} · {ROLE_LABEL[user.role]}</span>
              {user.photo
                ? <img className="avatar avatar-img" src={user.photo} alt={user.name} />
                : <div className="avatar">{user.name.split(' ').map((w) => w[0]).join('').slice(0, 2)}</div>}
            </NavLink>
            <button className="btn ghost sm desk-only" onClick={logout}><LogOut size={13} /> {t('nav.logout')}</button>
          </div>
        </header>

        {/* Read-only lockdown: trial/subscription expired (grace included).
            Everything stays visible and downloadable as usual - the server
            refuses any change until payment. (Support mode bypasses this.) */}
        {!isSuper && !impersonating && subscription?.expired && (
          <div className="grace-banner locked-banner">
            <span>
              🔒 <b>{subscription.status === 'TRIAL' ? 'Your free trial has ended' : 'Your subscription has expired'}</b> - the
              workspace is now <b>view-only</b>. You can see and download everything as usual, but nothing can
              be added or changed until {can('billing') ? 'you renew' : 'your admin renews'}. All your data is safe.
            </span>
            {can('billing') && <NavLink className="btn sm" to="/billing">Pay & unlock</NavLink>}
          </div>
        )}

        {/* Grace window: coverage ended, but the workspace stays open for
            subscription.graceDays extra days under this renewal warning. */}
        {!isSuper && !impersonating && subscription?.inGrace && (
          <div className="grace-banner">
            <span>
              ⚠ Your <b>{subscription.plan ?? ''} subscription ended {fmtDay(subscription.paidUntil)}</b> - the
              workspace locks {fmtDay(subscription.graceEndsAt)} at the latest
              ({Math.max(1, Math.ceil((new Date(subscription.graceEndsAt) - Date.now()) / 86400000))} day{Math.ceil((new Date(subscription.graceEndsAt) - Date.now()) / 86400000) > 1 ? 's' : ''} left). Renew now to keep working without interruption.
            </span>
            {can('billing') && <NavLink className="btn sm" to="/billing">Renew now</NavLink>}
          </div>
        )}

        <div className="content">
          <Routes>
            {isSuper ? (
              <>
                <Route path="/admin" element={<Admin />} />
                <Route path="/admin/companies" element={<Companies />} />
                <Route path="/admin/demos" element={<Demos />} />
                <Route path="/admin/payments" element={<Payments />} />
                <Route path="/admin/settings" element={<AdminSettings />} />
                <Route path="/account" element={<Account />} />
                <Route path="*" element={<Navigate to="/admin" />} />
              </>
            ) : (
              <>
                <Route path="/" element={<Dashboard />} />
                {can('projects.view') && <Route path="/projects" element={<Projects />} />}
                {can('phases.view') && <Route path="/phases" element={<Kanban />} />}
                {can('phases.view') && <Route path="/phases/:id/report" element={<PhaseReport />} />}
                {can('schedule.view') && <Route path="/schedule" element={<Schedule />} />}
                {can('updates.view') && <Route path="/updates" element={<Updates />} />}
                {can('docs.view') && <Route path="/documents" element={<Documents />} />}
                {can('attendance.view') && <Route path="/attendance" element={<Attendance />} />}
                {can('stock.view') && <Route path="/stock" element={<Stock />} />}
                {can('chat') && <Route path="/chat" element={<Chat />} />}
                {can('team.view') && <Route path="/team" element={<Team />} />}
                {can('reports') && <Route path="/reports" element={<Reports />} />}
                {can('settings.edit') && <Route path="/settings" element={<Settings />} />}
                {can('billing') && <Route path="/billing" element={<Billing />} />}
                <Route path="/account" element={<Account />} />
                <Route path="*" element={<Navigate to="/" />} />
              </>
            )}
          </Routes>
        </div>

        {isSuper && <DemoAlerts />}

        {/* Phone bottom navigation - the design board's ENTER flow, shipped */}
        {!isSuper && (
          <nav className="bnav mobile-only">
            {MOBILE_SLOTS.map((s, i) => {
              if (!can(s.cap)) return null
              // Admins receive daily reports, they don't submit - no FAB.
              if (s.fab && user.role === 'CLIENT') return null
              if (s.fab) return (
                <button key="fab" className="bnav-fab" aria-label={t('nav.newUpdate')}
                  onClick={() => nav2('/updates', { state: { openNew: Date.now() } })}>
                  <Plus size={22} />
                </button>
              )
              return (
                <NavLink key={s.to} to={s.to} end={s.to === '/'}
                  className={({ isActive }) => 'bnav-item' + (isActive ? ' on' : '')}>
                  <s.icon size={19} />
                  <span>{t(s.key)}</span>
                </NavLink>
              )
            })}
          </nav>
        )}

        {/* "More" sheet: the rest of the workspace, account & language */}
        {moreOpen && (
          <div className="sheet-back" onClick={() => setMoreOpen(false)}>
            <div className="more-sheet" onClick={(e) => e.stopPropagation()}>
              <div className="sheet-grab" />
              <div className="more-head">
                {user.photo
                  ? <img className="avatar avatar-img" src={user.photo} alt={user.name} />
                  : <div className="avatar">{user.name.split(' ').map((w) => w[0]).join('').slice(0, 2)}</div>}
                <div style={{ flex: 1 }}>
                  <b>{user.name}</b>
                  <span className="small muted" style={{ display: 'block' }}>{ROLE_LABEL[user.role]} · {client?.company}</span>
                </div>
                <button className="btn ghost sm" onClick={() => setMoreOpen(false)}><X size={14} /></button>
              </div>
              <div className="more-list">
                {nav.filter((n) => !MOBILE_SLOTS.some((s) => s.to === n.to)).map((n) => (
                  <NavLink key={n.to} to={n.to} onClick={() => setMoreOpen(false)}>
                    <n.icon size={17} /> {n.label ?? t(n.key)}
                  </NavLink>
                ))}
                <NavLink to="/account" onClick={() => setMoreOpen(false)}>
                  <Users size={17} /> {t('nav.account')}
                </NavLink>
              </div>
              <div className="more-foot">
                <LanguagePicker compact />
                <button className="btn ghost sm" onClick={logout}><LogOut size={13} /> {t('nav.logout')}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
