import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { X, Download, AlertTriangle, HelpCircle, Info } from 'lucide-react'

export function Modal({ title, onClose, children }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="flex-between" style={{ marginBottom: 14 }}>
          <b style={{ fontSize: 15 }}>{title}</b>
          <button className="btn ghost sm" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ---- In-app dialogs ----
// Replaces window.confirm / alert / prompt, which render as a bare browser bar
// pinned to the top of the window with the app's own styling nowhere in sight.
// Same await-able shape as the native calls, so callers read the same way:
//   if (!await confirm('Delete this?')) return
//   const name = await prompt('Rename to:', current)   // null when cancelled

const DialogCtx = createContext(null)
export const useDialog = () => useContext(DialogCtx)

export function DialogProvider({ children }) {
  const [dlg, setDlg] = useState(null)
  const [value, setValue] = useState('')
  const inputRef = useRef(null)
  const okRef = useRef(null)

  const open = useCallback((opts) => new Promise((resolve) => {
    setValue(opts.defaultValue ?? '')
    setDlg({ ...opts, resolve })
  }), [])

  const api = useRef({
    confirm: (message, opts = {}) => open({ kind: 'confirm', message, ...opts }),
    alert: (message, opts = {}) => open({ kind: 'alert', message, ...opts }),
    prompt: (message, defaultValue = '', opts = {}) => open({ kind: 'prompt', message, defaultValue, ...opts }),
  }).current

  const close = (result) => {
    dlg?.resolve(result)
    setDlg(null)
  }

  // Focus the natural control so the keyboard works the way the native dialog did.
  useEffect(() => {
    if (!dlg) return
    const t = setTimeout(() => (dlg.kind === 'prompt' ? inputRef.current : okRef.current)?.focus(), 30)
    return () => clearTimeout(t)
  }, [dlg])

  useEffect(() => {
    if (!dlg) return
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(dlg.kind === 'prompt' ? null : false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const submit = (e) => {
    e?.preventDefault()
    if (dlg.kind === 'prompt') return close(value.trim() ? value : null)
    close(true)
  }

  const cancelled = () => close(dlg.kind === 'prompt' ? null : false)
  const danger = dlg?.danger
  const Icon = dlg?.kind === 'alert' ? Info : danger ? AlertTriangle : HelpCircle

  return (
    <DialogCtx.Provider value={api}>
      {children}
      {dlg && (
        <div className="modal-back dialog-back" onClick={cancelled} role="presentation">
          <div className="modal dialog" onClick={(e) => e.stopPropagation()}
            role="alertdialog" aria-modal="true" aria-label={dlg.title ?? 'Confirm'}>
            <div className="dialog-head">
              <span className={`dialog-icon ${danger ? 'danger' : dlg.kind === 'alert' ? 'info' : ''}`}>
                <Icon size={18} />
              </span>
              <b>{dlg.title ?? (dlg.kind === 'alert' ? 'Notice' : dlg.kind === 'prompt' ? 'Enter a value' : 'Are you sure?')}</b>
            </div>
            <form onSubmit={submit}>
              {dlg.message && <p className="dialog-text">{dlg.message}</p>}
              {dlg.kind === 'prompt' && (
                <input ref={inputRef} value={value} onChange={(e) => setValue(e.target.value)}
                  placeholder={dlg.placeholder ?? ''} style={{ width: '100%', marginBottom: 4 }} />
              )}
              <div className="dialog-actions">
                {dlg.kind !== 'alert' && (
                  <button type="button" className="btn ghost" onClick={cancelled}>
                    {dlg.cancelText ?? 'Cancel'}
                  </button>
                )}
                <button ref={okRef} type="submit" className={`btn ${danger ? 'danger' : ''}`}>
                  {dlg.confirmText ?? (dlg.kind === 'alert' ? 'OK' : dlg.kind === 'prompt' ? 'Save' : 'Confirm')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </DialogCtx.Provider>
  )
}

export function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  )
}

export function ErrorNote({ error }) {
  if (!error) return null
  return <div className="error-note">{error}</div>
}

// Tiny helper for form state
export function useForm(initial) {
  const [values, setValues] = useState(initial)
  const set = (k) => (e) => setValues((v) => ({ ...v, [k]: e.target.value }))
  return [values, set, setValues]
}

// Shows the person's photo when they have one; falls back to initials.
export const Avatar = ({ name, photo }) => photo
  ? <img className="avatar avatar-img" src={photo} alt={name ?? ''} title={name} />
  : <div className="avatar">{(name ?? '?').split(' ').map((w) => w[0]).join('').slice(0, 2)}</div>

// In-app photo viewer. img: { url, name, download: boolean }
export function Lightbox({ img, onClose }) {
  if (!img) return null
  return (
    <div className="lightbox-back" onClick={onClose}>
      <div className="lightbox-head" onClick={(e) => e.stopPropagation()}>
        <span>{img.name ?? 'Photo'}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          {img.download && (
            <a className="btn sm" href={img.url} download={img.name || true}>
              <Download size={13} /> Download
            </a>
          )}
          <button className="btn ghost sm" onClick={onClose}><X size={13} /> Close</button>
        </div>
      </div>
      <img className="lightbox-img" src={img.url} alt={img.name ?? ''} onClick={(e) => e.stopPropagation()} />
    </div>
  )
}
