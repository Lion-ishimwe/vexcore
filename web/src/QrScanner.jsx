import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'

// Camera QR scanner - the same tech as the attendance kiosk: native
// BarcodeDetector where available (Android/Chrome), jsQR fallback
// (iPhone/Safari). Calls onScan(code); repeats of the same code are ignored
// for 3 seconds. Requires HTTPS (or localhost) for camera access.
export default function QrScanner({ onScan, height = 230 }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const lastRef = useRef({ code: null, at: 0 })
  const onScanRef = useRef(onScan)
  onScanRef.current = onScan
  const [err, setErr] = useState(null)

  useEffect(() => {
    let running = true
    let raf = null
    const start = async () => {
      try {
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
        const tick = async () => {
          if (!running) return
          raf = requestAnimationFrame(tick)
          if (v.readyState !== 4) return
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
          if (code === lastRef.current.code && now - lastRef.current.at < 3000) return
          lastRef.current = { code, at: now }
          onScanRef.current?.(code)
        }
        raf = requestAnimationFrame(tick)
      } catch (e) {
        setErr(e.insecure
          ? 'Camera needs HTTPS - on a phone, start the app with "npm run dev:https" (typing the card id still works)'
          : e.name === 'NotAllowedError'
            ? 'Camera permission denied - allow it in the browser settings'
            : (e.message || 'Camera unavailable'))
      }
    }
    start()
    return () => {
      running = false
      if (raf) cancelAnimationFrame(raf)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [])

  if (err) return <div className="error-note">{err}</div>
  return (
    <video ref={videoRef} playsInline muted
      style={{ width: '100%', maxHeight: height, borderRadius: 12, background: '#0b0f14', objectFit: 'cover' }} />
  )
}
