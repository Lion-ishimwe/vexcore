import { useEffect, useRef, useState } from 'react'
import {
  Mic, Square, Paperclip, Video, Send, X, FileText, Music, PhoneCall, BellRing,
  Users, Lock,
} from 'lucide-react'
import { api } from '../api.js'
import { useAuth } from '../auth.jsx'
import { useT } from '../i18n.jsx'
import { Avatar, Modal, Lightbox } from '../ui.jsx'

const ROLE_LABEL = { CLIENT: 'Admin', SENIOR: 'Senior Engineer', SITE: 'Site Engineer', STOCK: 'Stock Manager', GUEST: 'Guest' }

// Public Jitsi instance that permits iframe embedding (no X-Frame-Options/CSP wall)
// and needs no login; swap for a self-hosted server later (PRD 8.7).
const JITSI_BASE = 'https://fairmeeting.net'

const seenKey = 'bridge_chat_seen'
const getSeen = () => { try { return JSON.parse(localStorage.getItem(seenKey)) ?? {} } catch { return {} } }
const markSeen = (convo) => {
  const seen = getSeen()
  seen[convo] = new Date().toISOString()
  localStorage.setItem(seenKey, JSON.stringify(seen))
}

function fmtSecs(s) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function Attachment({ a, onJoinCall, myId }) {
  if (a.kind === 'call') {
    const invitedMe = (a.invited ?? []).includes(myId)
    return (
      <div className={`att-call ${invitedMe ? 'invited' : ''}`}>
        <PhoneCall size={16} />
        <div>
          <b>Video call {invitedMe && <span className="badge amber">You're invited</span>}</b>
          <span>Room {a.room.slice(-6)}</span>
        </div>
        <button className="btn sm" onClick={() => onJoinCall(a.room)}>Join</button>
      </div>
    )
  }
  if (a.kind === 'audio') return <audio className="att-audio" controls src={a.url} preload="metadata" />
  if (a.kind === 'image') return (
    <img className="att-img" src={a.url} alt={a.name} title="Click to view"
      onClick={() => a.onOpen?.({ url: a.url, name: a.name, download: true })} />
  )
  if (a.kind === 'video') return <video className="att-video" controls src={a.url} />
  return (
    <a className="att-file" href={a.url} download={a.name}>
      <FileText size={15} /> {a.name}
    </a>
  )
}

export default function Chat() {
  const { user, client } = useAuth()
  const { t } = useT()
  const [convo, setConvo] = useState('all') // 'all' | member user id
  const [messages, setMessages] = useState(null)
  const [members, setMembers] = useState([])
  const [threads, setThreads] = useState({ channelLastAt: null, threads: [], incomingCall: null })
  const [text, setText] = useState('')
  const [pending, setPending] = useState([]) // File[]
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [call, setCall] = useState(null) // active room name
  const [inviteOpen, setInviteOpen] = useState(false)
  const [invited, setInvited] = useState([])
  const [dismissed, setDismissed] = useState([])
  const [lightbox, setLightbox] = useState(null)
  // recording state
  const [recording, setRecording] = useState(false)
  const [recTime, setRecTime] = useState(0)
  const recRef = useRef(null)
  const timerRef = useRef(null)
  const bottomRef = useRef(null)
  const fileRef = useRef(null)
  const convoRef = useRef(convo)
  convoRef.current = convo

  const load = () => {
    // Remember which conversation this request was for. On a slow link the
    // 4-second poll for one thread could land after the user switched to
    // another, painting the wrong messages under the new header - and marking
    // the new thread read using the old thread's data.
    const asked = convoRef.current
    api(`/messages?to=${asked}`).then((msgs) => {
      if (convoRef.current !== asked) return
      setMessages(msgs)
      markSeen(String(asked))
    }).catch((e) => { if (convoRef.current === asked) setError(e.message) })
    api('/messages/threads').then(setThreads).catch(() => {})
  }

  useEffect(() => {
    api('/members').then(setMembers).catch(() => {})
    const t = setInterval(load, 4000)
    return () => {
      clearInterval(t)
      stopTimer()
      // Leaving the page mid-recording used to leave the microphone open for
      // the rest of the session (rec.onstop never fires if nobody stops it).
      const rec = recRef.current
      if (rec && rec.state !== 'inactive') {
        try { rec.stop() } catch { /* already gone */ }
        rec.stream?.getTracks?.().forEach((t) => t.stop())
      }
    }
  }, [])

  useEffect(() => { setMessages(null); load() }, [convo])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages?.length])

  const stopTimer = () => { if (timerRef.current) clearInterval(timerRef.current) }

  // ---- Voice notes ----
  const startRecording = async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      const chunks = []
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
        const ext = (rec.mimeType || 'audio/webm').includes('ogg') ? 'ogg' : 'webm'
        setPending((p) => [...p, new File([blob], `voice-note-${Date.now()}.${ext}`, { type: blob.type })])
      }
      rec.start()
      recRef.current = rec
      setRecording(true)
      setRecTime(0)
      timerRef.current = setInterval(() => setRecTime((t) => t + 1), 1000)
    } catch {
      setError('Microphone not available - allow mic access in your browser and try again.')
    }
  }

  const stopRecording = () => {
    recRef.current?.stop()
    setRecording(false)
    stopTimer()
  }

  // ---- Send ----
  const send = async (e) => {
    e?.preventDefault()
    if (!text.trim() && !pending.length) return
    setBusy(true); setError(null)
    try {
      const form = new FormData()
      form.append('text', text)
      if (convo !== 'all') form.append('recipientId', convo)
      for (const f of pending) form.append('files', f)
      await api('/messages', { method: 'POST', form })
      setText(''); setPending([])
      load()
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  // ---- Video calls ----
  const openInvite = () => {
    // In a DM, pre-invite the person you're talking to.
    setInvited(convo !== 'all' ? [+convo] : [])
    setInviteOpen(true)
  }

  const startCall = async () => {
    setError(null)
    const room = `bridge-${client.id}-${Date.now().toString(36)}`
    const names = members.filter((m) => invited.includes(m.id)).map((m) => m.name)
    try {
      const form = new FormData()
      form.append('text', names.length
        ? `Started a video call - inviting ${names.join(', ')}`
        : 'Started a video call - join me!')
      form.append('callRoom', room)
      form.append('invited', JSON.stringify(invited))
      if (convo !== 'all') form.append('recipientId', convo)
      await api('/messages', { method: 'POST', form })
      setInviteOpen(false); setInvited([])
      load()
      setCall(room)
    } catch (err) { setError(err.message) }
  }

  const toggleInvite = (id) =>
    setInvited((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])

  const others = members.filter((m) => m.id !== user.id)
  const partner = convo === 'all' ? null : members.find((m) => m.id === +convo)

  // Unread dots: any thread activity newer than when I last opened that conversation.
  const seen = getSeen()
  const unread = (key, lastAt) => {
    if (!lastAt) return false
    if (String(convo) === String(key)) return false
    const s = seen[String(key)]
    return !s || new Date(lastAt) > new Date(s)
  }
  const threadLast = (id) => threads.threads.find((t) => t.userId === id)?.lastAt

  const incoming = threads.incomingCall && !dismissed.includes(threads.incomingCall.msgId)
    ? threads.incomingCall : null

  return (
    <>
      {error && <div className="error-note">{error}</div>}

      {incoming && (
        <div className="ring-banner">
          <BellRing size={17} className="ring-bell" />
          <span><b>{incoming.from}</b> invited you to a video call</span>
          <button className="btn sm" onClick={() => {
            setCall(incoming.room)
            setDismissed((d) => [...d, incoming.msgId])
          }}>Join now</button>
          <button className="btn ghost sm" onClick={() => setDismissed((d) => [...d, incoming.msgId])}>Dismiss</button>
        </div>
      )}

      <div className="chat-layout">
        <div className="card convo-card">
          <div className="convo-section">Conversations</div>
          <button className={`convo-row ${convo === 'all' ? 'active' : ''}`} onClick={() => setConvo('all')}>
            <span className="convo-all-icon"><Users size={15} /></span>
            <div><b>{t('chat.everyone')}</b><span>{t('chat.channel')}</span></div>
            {unread('all', threads.channelLastAt) && <i className="unread-dot" />}
          </button>
          <div className="convo-section">{t('chat.dm')}</div>
          {others.map((m) => (
            <button className={`convo-row ${String(convo) === String(m.id) ? 'active' : ''}`} key={m.id}
              onClick={() => setConvo(m.id)}>
              <Avatar name={m.name} photo={m.photo} />
              <div><b>{m.name}</b><span>{ROLE_LABEL[m.role] ?? m.role}</span></div>
              {unread(m.id, threadLast(m.id)) && <i className="unread-dot" />}
            </button>
          ))}
        </div>

        <div className="card chat-main">
          <div className="flex-between chat-head">
            <div className="chat-title">
              {partner ? <Avatar name={partner.name} photo={partner.photo} /> : <span className="convo-all-icon"><Users size={15} /></span>}
              <div>
                <b>{partner ? partner.name : t('chat.everyone')}</b>
                <span>{partner
                  ? <><Lock size={10} /> Private - only you and {partner.name.split(' ')[0]} can see this</>
                  : `Company channel · ${client.company}`}</span>
              </div>
            </div>
            <button className="btn sm" onClick={openInvite}><Video size={13} /> Video call</button>
          </div>

          <div className="chat-box" style={{ maxHeight: '46vh', overflowY: 'auto', paddingRight: 6 }}>
            {messages === null && <div className="spin">Loading…</div>}
            {messages?.map((m) => (
              <div className={`msg ${m.mine ? 'me' : ''}`} key={m.id}>
                <Avatar name={m.from} photo={m.fromPhoto} />
                <div className="msg-bubble">
                  <div className="msg-head">
                    <b>{m.from}</b> · {ROLE_LABEL[m.role] ?? m.role} · {new Date(m.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                  {m.text && <div className="msg-text">{m.text}</div>}
                  {m.attachments?.length > 0 && (
                    <div className="msg-atts">
                      {m.attachments.map((a, i) => (
                        <Attachment a={{ ...a, onOpen: setLightbox }} key={i} onJoinCall={setCall} myId={user.id} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {messages?.length === 0 && (
              <div className="muted small">
                {partner ? `No messages with ${partner.name} yet - start the conversation.` : 'No messages yet - say hello.'}
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {pending.length > 0 && (
            <div className="pending-row">
              {pending.map((f, i) => (
                <span className="chip" key={i}>
                  {f.type.startsWith('audio') ? <Music size={12} /> : <Paperclip size={12} />}
                  {f.name.length > 26 ? f.name.slice(0, 24) + '…' : f.name}
                  <X size={12} style={{ cursor: 'pointer' }}
                    onClick={() => setPending((p) => p.filter((_, j) => j !== i))} />
                </span>
              ))}
            </div>
          )}

          <form className="chat-input" onSubmit={send}>
            <input type="file" multiple hidden ref={fileRef}
              onChange={(e) => { setPending((p) => [...p, ...e.target.files]); e.target.value = '' }} />
            <button type="button" className="btn ghost icon-btn" title="Attach files"
              onClick={() => fileRef.current.click()}>
              <Paperclip size={16} />
            </button>
            {recording ? (
              <button type="button" className="btn icon-btn rec-live" title="Stop recording" onClick={stopRecording}>
                <Square size={14} /> <span className="rec-dot" /> {fmtSecs(recTime)}
              </button>
            ) : (
              <button type="button" className="btn ghost icon-btn" title="Record voice note" onClick={startRecording}>
                <Mic size={16} />
              </button>
            )}
            <input placeholder={recording ? '● …'
              : partner ? `${partner.name.split(' ')[0]} · ${t('chat.private').toLowerCase()}…` : t('chat.message')}
              value={text} onChange={(e) => setText(e.target.value)} disabled={recording} />
            <button className="btn" disabled={busy || recording}><Send size={13} /> {t('common.send')}</button>
          </form>
        </div>
      </div>

      <Lightbox img={lightbox} onClose={() => setLightbox(null)} />

      {inviteOpen && (
        <Modal title="Start a video call" onClose={() => setInviteOpen(false)}>
          <p className="small muted" style={{ marginBottom: 14 }}>
            {partner
              ? `This call will be posted in your private conversation with ${partner.name}.`
              : `Pick who to invite from ${client.company}. Invitees get a ping in their chat; the call card stays visible to the whole company either way.`}
          </p>
          <div className="invite-list">
            {others.map((m) => (
              <label className="invite-row" key={m.id}>
                <input type="checkbox" checked={invited.includes(m.id)} onChange={() => toggleInvite(m.id)} />
                <Avatar name={m.name} photo={m.photo} />
                <div>
                  <b>{m.name}</b>
                  <span>{ROLE_LABEL[m.role] ?? m.role}</span>
                </div>
              </label>
            ))}
            {!others.length && <div className="muted small">No other members yet - add teammates on the Team page.</div>}
          </div>
          <div className="flex-between" style={{ marginTop: 16 }}>
            <button type="button" className="btn ghost sm"
              onClick={() => setInvited(invited.length === others.length ? [] : others.map((m) => m.id))}>
              {invited.length === others.length && others.length ? 'Clear all' : 'Select all'}
            </button>
            <button className="btn" onClick={startCall}>
              <Video size={14} /> Start call{invited.length ? ` · invite ${invited.length}` : ''}
            </button>
          </div>
        </Modal>
      )}

      {call && (
        <div className="call-back">
          <div className="call-frame">
            <div className="call-head">
              <b><Video size={15} /> Video call - {client.company}</b>
              <div style={{ display: 'flex', gap: 8 }}>
                <a className="btn ghost sm" href={`${JITSI_BASE}/${call}`} target="_blank" rel="noreferrer">Open in tab</a>
                <button className="btn sm" style={{ background: 'var(--red)', color: '#fff' }}
                  onClick={() => setCall(null)}>Leave</button>
              </div>
            </div>
            <iframe
              title="Video call"
              src={`${JITSI_BASE}/${call}#userInfo.displayName="${encodeURIComponent(user.name)}"&config.prejoinConfig.enabled=true`}
              allow="camera; microphone; fullscreen; display-capture; autoplay; clipboard-write"
            />
            <div className="call-note">
              Video not loading? Use <b>Open in tab</b> above - some networks block embedded calls.
            </div>
          </div>
        </div>
      )}
    </>
  )
}
