import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { LogIn, LogOut, X, CheckCircle2, AlertTriangle, ArrowLeft, Camera, CameraOff } from 'lucide-react'
import jsQR from 'jsqr'
import { api } from '../api.js'
import { useT } from '../i18n.jsx'

const hhmm = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

// Fullscreen gate screen. A USB RFID/NFC reader acts as a keyboard: it "types"
// the card id and presses Enter - the hidden input below catches every scan.
// Phone-camera QR scanners that type into a focused field work the same way.
export default function Kiosk() {
  const { t } = useT()
  const { id } = useParams()
  const [session, setSession] = useState(null)
  const [feedback, setFeedback] = useState(null) // {kind, title, sub}
  const [recent, setRecent] = useState([])
  const [buffer, setBuffer] = useState('')
  const inputRef = useRef(null)
  // camera QR scanner
  const [camera, setCamera] = useState(() => localStorage.getItem('kiosk_cam') === '1')
  const [camErr, setCamErr] = useState(null)
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const lastScanRef = useRef({ code: null, at: 0 })
  const scanRef = useRef(null)

  // A bookmarked kiosk whose session was closed and pruned - or a tablet that
  // lost Wi-Fi at boot - used to sit on "Loading…" for ever, silently retrying,
  // with nothing to tell the gate guard that taps were not being recorded.
  const [loadError, setLoadError] = useState(null)
  const loadSession = () =>
    api(`/attendance/sessions/${id}`)
      .then((s) => { setSession(s); setLoadError(null) })
      .catch((e) => setLoadError(e.message || 'Cannot reach the server'))

  useEffect(() => {
    loadSession()
    const t = setInterval(loadSession, 8000)
    const keep = setInterval(() => inputRef.current?.focus(), 1500)
    return () => { clearInterval(t); clearInterval(keep) }
  }, [id])

  const flash = (kind, title, sub) => {
    setFeedback({ kind, title, sub })
    setTimeout(() => setFeedback((f) => (f?.title === title ? null : f)), 3500)
  }

  const scan = async (cardId) => {
    if (!cardId.trim()) return
    try {
      const r = await api(`/attendance/sessions/${id}/scan`, { method: 'POST', body: { cardId } })
      const at = hhmm(r.at)
      navigator.vibrate?.(70)
      if (r.action === 'in') {
        flash('in', r.worker.name, `${t('kiosk.clockedIn')} · ${at}`)
        setRecent((l) => [{ kind: 'in', name: r.worker.name, at }, ...l].slice(0, 6))
      } else if (r.action === 'out') {
        flash('out', r.worker.name, `${t('kiosk.clockedOut')} · ${at}`)
        setRecent((l) => [{ kind: 'out', name: r.worker.name, at }, ...l].slice(0, 6))
      } else {
        flash('dup', r.worker.name, `${t('kiosk.dup')} · ${at}`)
      }
      loadSession()
    } catch (err) {
      navigator.vibrate?.([60, 60, 60])
      flash('err', err.message.includes('recognised') ? t('kiosk.unknown') : 'Cannot record', err.message)
    }
  }
  scanRef.current = scan

  // ---- Camera QR scanning: native BarcodeDetector (Android/Chrome) with a
  // jsQR fallback (iPhone/Safari). Cards are scanned one by one - the same
  // code is ignored for 4s, and accepts are spaced ≥1.2s apart.
  useEffect(() => {
    localStorage.setItem('kiosk_cam', camera ? '1' : '0')
    if (!camera) return
    let running = true
    let raf = null
    const start = async () => {
      try {
        setCamErr(null)
        if (!window.isSecureContext) throw Object.assign(new Error(), { insecure: true })
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no camera support')
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }, audio: false,
        })
        if (!running) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        const v = videoRef.current
        v.srcObject = stream
        await v.play()
        let detector = null
        if ('BarcodeDetector' in window) {
          try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }) } catch { detector = null }
        }
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        let lastTick = 0
        const tick = async (t) => {
          if (!running) return
          raf = requestAnimationFrame(tick)
          if (t - lastTick < 180 || v.readyState < 2) return
          lastTick = t
          let code = null
          if (detector) {
            const found = await detector.detect(v).catch(() => [])
            code = found[0]?.rawValue ?? null
          } else {
            const w = 480
            const h = Math.round(w * v.videoHeight / v.videoWidth) || 360
            canvas.width = w; canvas.height = h
            ctx.drawImage(v, 0, 0, w, h)
            const img = ctx.getImageData(0, 0, w, h)
            code = jsQR(img.data, w, h)?.data ?? null
          }
          if (!code) return
          const now = Date.now()
          const last = lastScanRef.current
          if (code === last.code && now - last.at < 4000) return
          if (now - last.at < 1200) return
          lastScanRef.current = { code, at: now }
          scanRef.current(code)
        }
        raf = requestAnimationFrame(tick)
      } catch (e) {
        setCamErr(e.insecure
          ? 'Camera needs HTTPS - start the app with "npm run dev:https" (or use a USB scanner)'
          : e.name === 'NotAllowedError'
            ? 'Camera permission denied - allow it in the browser settings'
            : (e.message || 'Camera unavailable'))
        setCamera(false)
      }
    }
    start()
    return () => {
      running = false
      if (raf) cancelAnimationFrame(raf)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [camera])

  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const v = buffer
      setBuffer('')
      scan(v)
    }
  }

  if (!session) return (
    <div className="kiosk">
      <div className={`kiosk-banner ${loadError ? 'red' : 'gray'}`}>
        {loadError ? 'Session unavailable - taps are NOT being recorded' : 'Loading…'}
      </div>
      {loadError && (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <p className="muted">{loadError}</p>
          <p className="muted small">Retrying every 8 seconds. Ask a manager to open a session and reload this page.</p>
          <button className="btn" onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}
    </div>
  )

  const closed = session.mode === 'closed'
  const win = session.windows
  // With windows on, the time of day decides what a tap does.
  const effective = win?.enabled ? win.current : session.mode
  const inMode = effective === 'in'
  const windowClosed = win?.enabled && !win.current && !closed

  return (
    <div className="kiosk" onClick={() => inputRef.current?.focus()}>
      <input
        ref={inputRef} className="kiosk-input" autoFocus
        value={buffer} onChange={(e) => setBuffer(e.target.value)} onKeyDown={onKey}
        aria-label="Card scan input"
      />

      <div className="kiosk-top">
        <Link to="/attendance" className="kiosk-exit"><ArrowLeft size={15} /> {t('kiosk.exit')}</Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button className="kiosk-cam-btn" onClick={(e) => { e.stopPropagation(); setCamera(!camera) }}>
            {camera ? <CameraOff size={15} /> : <Camera size={15} />}
            {camera ? t('kiosk.cameraOff') : t('kiosk.camera')}
          </button>
          <span>{session.project}{session.phase ? ` › ${session.phase}` : ''}</span>
        </div>
      </div>
      {camErr && <div className="kiosk-cam-err">{camErr}</div>}

      {closed ? (
        <div className="kiosk-banner gray"><X size={40} /> {t('kiosk.closed')}</div>
      ) : session.paused ? (
        <div className="kiosk-banner gray"><X size={40} /> {t('kiosk.pausedBanner')}</div>
      ) : windowClosed ? (
        <div className="kiosk-banner gray">
          <X size={40} /> {t('kiosk.attClosed')} · {win.inStart}–{win.inEnd} · {win.outStart}–{win.outEnd}
        </div>
      ) : (
        <div className={`kiosk-banner ${inMode ? 'green' : 'amber'}`}>
          {inMode ? <LogIn size={40} /> : <LogOut size={40} />}
          {inMode ? t('kiosk.tapIn') : t('kiosk.tapOut')}
          {win?.enabled && (
            <span className="kiosk-window">{t('kiosk.until')} {inMode ? win.inEnd : win.outEnd}</span>
          )}
        </div>
      )}

      <div className="kiosk-stage">
        {camera && (
          <div className="kiosk-cam" onClick={(e) => e.stopPropagation()}>
            <video ref={videoRef} playsInline muted />
            <div className="kiosk-cam-frame" />
          </div>
        )}
        {feedback ? (
          <div className={`kiosk-card ${feedback.kind} ${camera ? 'compact' : ''}`}>
            {feedback.kind === 'err' ? <AlertTriangle size={camera ? 34 : 54} /> : <CheckCircle2 size={camera ? 34 : 54} />}
            <b>{feedback.title}</b>
            <span>{feedback.sub}</span>
          </div>
        ) : (
          <div className="kiosk-idle">
            {closed ? t('kiosk.askManager')
              : session.paused ? t('kiosk.activateHint')
              : windowClosed ? t('kiosk.outsideHours')
              : camera ? t('kiosk.point') : t('kiosk.waiting')}
          </div>
        )}
      </div>

      {recent.length > 0 && (
        <div className="kiosk-recent">
          {recent.map((r, i) => (
            <span key={i} className={r.kind}>{r.name} · {r.kind === 'in' ? 'in' : 'out'} {r.at}</span>
          ))}
        </div>
      )}
    </div>
  )
}
