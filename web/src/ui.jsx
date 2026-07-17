import { useState } from 'react'
import { X, Download } from 'lucide-react'

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
