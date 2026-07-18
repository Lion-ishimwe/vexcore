import { createContext, useContext, useEffect, useState } from 'react'
import { api } from './api.js'
import { useAuth } from './auth.jsx'

// English is the default; every user picks their own language (stored on their
// account, so it follows them to any device). Missing keys fall back to English.
export const LANGS = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'rw', label: 'Kinyarwanda' },
]

const STR = {
  en: {
    // navigation & titles
    'nav.dashboard': 'Dashboard', 'nav.home': 'Home', 'nav.projects': 'Projects',
    'nav.phases': 'Phases & Tasks', 'nav.updates': 'Daily Updates', 'nav.documents': 'Documents',
    'nav.attendance': 'Attendance', 'nav.stock': 'Stock', 'nav.chat': 'Chat',
    'nav.team': 'Team', 'nav.reports': 'Reports', 'nav.settings': 'Settings',
    'nav.billing': 'Billing',
    'nav.account': 'My Account', 'nav.logout': 'Log out', 'nav.more': 'More',
    'nav.newUpdate': 'New update',
    // common
    'common.save': 'Save', 'common.cancel': 'Cancel', 'common.close': 'Close',
    'common.upload': 'Upload', 'common.download': 'Download', 'common.print': 'Print',
    'common.search': 'Search…', 'common.send': 'Send', 'common.loading': 'Loading…',
    'common.refresh': 'Refresh', 'common.language': 'Language',
    // login
    'login.title': 'Welcome back', 'login.sub': 'Log in to your CMS workspace.',
    'login.email': 'Email', 'login.password': 'Password', 'login.btn': 'Log in',
    'login.busy': 'Logging in…', 'login.verify': 'Verify & log in',
    'login.totp': 'Two-factor code (from your authenticator app, or a backup code)',
    'login.forgot': 'Forgot password?', 'login.create': 'Create an account',
    // dashboard
    'dash.activeProjects': 'Active projects', 'dash.completion': 'Overall completion',
    'dash.spend': 'Spend to date', 'dash.stockValue': 'Stock value',
    'dash.phaseCompletion': 'Phase completion', 'dash.designs': 'Project designs',
    'dash.latest': 'Latest from the field', 'dash.progress': 'Progress overview',
    // attendance
    'att.today': 'Today', 'att.workers': 'Workers', 'att.badges': 'Badges',
    'att.cards': 'Cards', 'att.report': 'Report',
    'att.clockIn': 'Clock-in', 'att.clockOut': 'Clock-out',
    'att.openKiosk': 'Open kiosk', 'att.closeSession': 'Close session',
    'att.newSession': 'New session', 'att.startSession': 'Start session',
    'att.clockOutAll': 'Clock out everyone', 'att.activate': 'Activate',
    'att.paused': 'Paused - not receiving taps', 'att.wholeProject': 'Whole project',
    'att.enrol': 'Enrol worker', 'att.in': 'clocked in', 'att.out': 'clocked out',
    // kiosk (workers read this screen)
    'kiosk.tapIn': 'TAP YOUR CARD TO CLOCK IN', 'kiosk.tapOut': 'TAP YOUR CARD TO CLOCK OUT',
    'kiosk.closed': 'SESSION CLOSED', 'kiosk.until': 'until',
    'kiosk.pausedBanner': 'PHASE PAUSED - another phase is recording',
    'kiosk.attClosed': 'ATTENDANCE CLOSED',
    'kiosk.waiting': 'Waiting for a card…',
    'kiosk.point': 'Point the camera at the QR on the card',
    'kiosk.clockedIn': 'Clocked in', 'kiosk.clockedOut': 'Clocked out',
    'kiosk.dup': 'Already recorded', 'kiosk.unknown': 'Card not recognised',
    'kiosk.exit': 'Exit kiosk', 'kiosk.camera': 'Camera scan', 'kiosk.cameraOff': 'Camera off',
    'kiosk.askManager': 'Ask a manager to start a new session',
    'kiosk.activateHint': 'Activate this phase on the Attendance page to resume taps',
    'kiosk.outsideHours': 'Taps outside the hours are not recorded',
    // chat
    'chat.everyone': 'Everyone', 'chat.channel': 'Company channel',
    'chat.message': 'Write a message…', 'chat.private': 'Private',
    'chat.call': 'Video call', 'chat.join': 'Join', 'chat.startCall': 'Start video call',
    'chat.dm': 'Direct messages',
    // daily updates
    'upd.submit': 'Submit Daily Update', 'upd.builders': 'Builders on site',
    'upd.helpers': 'Helpers on site', 'upd.useCounts': 'Use these counts',
    'upd.fromAtt': "Today's attendance",
    // account
    'account.profile': 'Profile', 'account.password': 'Change password',
    'account.2fa': 'Two-factor authentication',
    'account.languageSub': 'The interface follows you on every device',
  },

  fr: {
    'nav.dashboard': 'Tableau de bord', 'nav.home': 'Accueil', 'nav.projects': 'Projets',
    'nav.phases': 'Phases & tâches', 'nav.updates': 'Rapports journaliers', 'nav.documents': 'Documents',
    'nav.attendance': 'Présence', 'nav.stock': 'Stock', 'nav.chat': 'Messages',
    'nav.team': 'Équipe', 'nav.reports': 'Rapports', 'nav.settings': 'Paramètres',
    'nav.billing': 'Facturation',
    'nav.account': 'Mon compte', 'nav.logout': 'Se déconnecter', 'nav.more': 'Plus',
    'nav.newUpdate': 'Nouveau rapport',
    'common.save': 'Enregistrer', 'common.cancel': 'Annuler', 'common.close': 'Fermer',
    'common.upload': 'Téléverser', 'common.download': 'Télécharger', 'common.print': 'Imprimer',
    'common.search': 'Rechercher…', 'common.send': 'Envoyer', 'common.loading': 'Chargement…',
    'common.refresh': 'Actualiser', 'common.language': 'Langue',
    'login.title': 'Bon retour', 'login.sub': 'Connectez-vous à votre espace CMS.',
    'login.email': 'E-mail', 'login.password': 'Mot de passe', 'login.btn': 'Se connecter',
    'login.busy': 'Connexion…', 'login.verify': 'Vérifier et se connecter',
    'login.totp': 'Code à deux facteurs (application ou code de secours)',
    'login.forgot': 'Mot de passe oublié ?', 'login.create': 'Créer un compte',
    'dash.activeProjects': 'Projets actifs', 'dash.completion': 'Avancement global',
    'dash.spend': 'Dépenses à ce jour', 'dash.stockValue': 'Valeur du stock',
    'dash.phaseCompletion': 'Avancement des phases', 'dash.designs': 'Plans du projet',
    'dash.latest': 'Dernières nouvelles du chantier', 'dash.progress': "Vue d'ensemble",
    'att.today': "Aujourd'hui", 'att.workers': 'Ouvriers', 'att.badges': 'Badges',
    'att.cards': 'Cartes', 'att.report': 'Rapport',
    'att.clockIn': 'Arrivée', 'att.clockOut': 'Sortie',
    'att.openKiosk': 'Ouvrir le kiosque', 'att.closeSession': 'Clôturer la session',
    'att.newSession': 'Nouvelle session', 'att.startSession': 'Démarrer la session',
    'att.clockOutAll': 'Pointer la sortie de tous', 'att.activate': 'Activer',
    'att.paused': 'En pause - ne reçoit pas de scans', 'att.wholeProject': 'Tout le projet',
    'att.enrol': 'Inscrire un ouvrier', 'att.in': 'arrivé(s)', 'att.out': 'sorti(s)',
    'kiosk.tapIn': 'TAPEZ VOTRE CARTE - ARRIVÉE', 'kiosk.tapOut': 'TAPEZ VOTRE CARTE - SORTIE',
    'kiosk.closed': 'SESSION CLÔTURÉE', 'kiosk.until': "jusqu'à",
    'kiosk.pausedBanner': 'PHASE EN PAUSE - une autre phase enregistre',
    'kiosk.attClosed': 'PRÉSENCE FERMÉE',
    'kiosk.waiting': "En attente d'une carte…",
    'kiosk.point': 'Visez le code QR de la carte',
    'kiosk.clockedIn': 'Arrivée enregistrée', 'kiosk.clockedOut': 'Sortie enregistrée',
    'kiosk.dup': 'Déjà enregistré', 'kiosk.unknown': 'Carte non reconnue',
    'kiosk.exit': 'Quitter le kiosque', 'kiosk.camera': 'Scanner caméra', 'kiosk.cameraOff': 'Caméra désactivée',
    'kiosk.askManager': 'Demandez à un responsable de démarrer une session',
    'kiosk.activateHint': 'Activez cette phase sur la page Présence pour reprendre',
    'kiosk.outsideHours': 'Les scans hors horaires ne sont pas enregistrés',
    'chat.everyone': 'Tout le monde', 'chat.channel': "Canal de l'entreprise",
    'chat.message': 'Écrire un message…', 'chat.private': 'Privé',
    'chat.call': 'Appel vidéo', 'chat.join': 'Rejoindre', 'chat.startCall': 'Démarrer un appel vidéo',
    'chat.dm': 'Messages privés',
    'upd.submit': 'Envoyer le rapport du jour', 'upd.builders': 'Maçons sur site',
    'upd.helpers': 'Aides sur site', 'upd.useCounts': 'Utiliser ces effectifs',
    'upd.fromAtt': 'Présence du jour',
    'account.profile': 'Profil', 'account.password': 'Changer le mot de passe',
    'account.2fa': 'Authentification à deux facteurs',
    'account.languageSub': "L'interface vous suit sur tous vos appareils",
  },

  rw: {
    'nav.dashboard': 'Imbonerahamwe', 'nav.home': 'Ahabanza', 'nav.projects': 'Imishinga',
    'nav.phases': "Ibyiciro n'imirimo", 'nav.updates': 'Raporo za buri munsi', 'nav.documents': 'Inyandiko',
    'nav.attendance': 'Ubwitabire', 'nav.stock': 'Ububiko', 'nav.chat': 'Ubutumwa',
    'nav.team': 'Ikipe', 'nav.reports': 'Raporo', 'nav.settings': 'Igenamiterere',
    'nav.billing': 'Kwishyura',
    'nav.account': 'Konti yanjye', 'nav.logout': 'Sohoka', 'nav.more': 'Ibindi',
    'nav.newUpdate': 'Raporo nshya',
    'common.save': 'Bika', 'common.cancel': 'Reka', 'common.close': 'Funga',
    'common.upload': 'Shyiramo', 'common.download': 'Kuramo', 'common.print': 'Capa',
    'common.search': 'Shakisha…', 'common.send': 'Ohereza', 'common.loading': 'Birimo gupakira…',
    'common.refresh': 'Vugurura', 'common.language': 'Ururimi',
    'login.title': 'Murakaza neza', 'login.sub': 'Injira muri CMS yawe.',
    'login.email': 'Imeyili', 'login.password': 'Ijambobanga', 'login.btn': 'Injira',
    'login.busy': 'Kwinjira…', 'login.verify': 'Emeza winjire',
    'login.totp': "Kode y'umutekano (iva kuri apulikasiyo cyangwa kode y'ingoboka)",
    'login.forgot': 'Wibagiwe ijambobanga?', 'login.create': 'Fungura konti',
    'dash.activeProjects': 'Imishinga irimo gukorwa', 'dash.completion': 'Aho imirimo igeze',
    'dash.spend': 'Amafaranga yakoreshejwe', 'dash.stockValue': "Agaciro k'ububiko",
    'dash.phaseCompletion': 'Aho ibyiciro bigeze', 'dash.designs': "Ibishushanyo by'umushinga",
    'dash.latest': 'Amakuru mashya yo ku rubuga', 'dash.progress': "Incamake y'imirimo",
    'att.today': 'Uyu munsi', 'att.workers': 'Abakozi', 'att.badges': 'Ibirango',
    'att.cards': 'Amakarita', 'att.report': 'Raporo',
    'att.clockIn': 'Kwinjira', 'att.clockOut': 'Gusohoka',
    'att.openKiosk': 'Fungura kiyosike', 'att.closeSession': 'Funga ibarura',
    'att.newSession': 'Ibarura rishya', 'att.startSession': 'Tangira ibarura',
    'att.clockOutAll': 'Sohora bose', 'att.activate': 'Koresha',
    'att.paused': 'Bihagaritswe - ntibiri kwakira', 'att.wholeProject': 'Umushinga wose',
    'att.enrol': 'Andika umukozi', 'att.in': 'binjiye', 'att.out': 'basohotse',
    'kiosk.tapIn': 'KANDA IKARITA YAWE - KWINJIRA', 'kiosk.tapOut': 'KANDA IKARITA YAWE - GUSOHOKA',
    'kiosk.closed': 'IBARURA RYARAFUNZWE', 'kiosk.until': 'kugeza',
    'kiosk.pausedBanner': 'IKI CYICIRO GIHAGARITSWE - ikindi kiri kwandikwa',
    'kiosk.attClosed': 'UBWITABIRE BWARAFUNZWE',
    'kiosk.waiting': 'Tegereza ikarita…',
    'kiosk.point': "Erekeza kamera ku ikarita (QR)",
    'kiosk.clockedIn': 'Yinjiye', 'kiosk.clockedOut': 'Yasohotse',
    'kiosk.dup': 'Byamaze kwandikwa', 'kiosk.unknown': 'Ikarita ntizwi',
    'kiosk.exit': 'Sohoka muri kiyosike', 'kiosk.camera': 'Sikana na kamera', 'kiosk.cameraOff': 'Funga kamera',
    'kiosk.askManager': 'Saba umuyobozi gutangiza ibarura',
    'kiosk.activateHint': "Koresha iki cyiciro ku ipaji y'Ubwitabire kugira ngo bikomeze",
    'kiosk.outsideHours': 'Ibikozwe nyuma y’amasaha ntibyandikwa',
    'chat.everyone': 'Bose', 'chat.channel': 'Urubuga rwa kompanyi',
    'chat.message': 'Andika ubutumwa…', 'chat.private': 'Bwite',
    'chat.call': 'Guhamagara video', 'chat.join': 'Injira', 'chat.startCall': 'Tangira video',
    'chat.dm': 'Ubutumwa bwite',
    'upd.submit': "Ohereza raporo y'umunsi", 'upd.builders': 'Abubatsi bahari',
    'upd.helpers': 'Abafasha bahari', 'upd.useCounts': 'Koresha iyi mibare',
    'upd.fromAtt': "Ubwitabire bw'uyu munsi",
    'account.profile': 'Umwirondoro', 'account.password': 'Hindura ijambobanga',
    'account.2fa': "Umutekano w'inzego ebyiri",
    'account.languageSub': 'Ururimi rugukurikira kuri buri gikoresho',
  },
}

const I18nCtx = createContext(null)
export const useT = () => useContext(I18nCtx)

export function I18nProvider({ children }) {
  const { user, updateUser } = useAuth()
  const [lang, setLangState] = useState(() => localStorage.getItem('bridge_lang') || 'en')

  // After login, the account's saved language wins.
  useEffect(() => {
    if (user?.language && user.language !== lang) {
      setLangState(user.language)
      localStorage.setItem('bridge_lang', user.language)
    }
  }, [user?.language]) // eslint-disable-line

  const setLang = async (code) => {
    setLangState(code)
    localStorage.setItem('bridge_lang', code)
    if (user) {
      try {
        await api('/account/profile', { method: 'PATCH', body: { language: code } })
        updateUser({ language: code })
      } catch { /* keep the local choice even if saving fails */ }
    }
  }

  const t = (key) => STR[lang]?.[key] ?? STR.en[key] ?? key
  return <I18nCtx.Provider value={{ t, lang, setLang }}>{children}</I18nCtx.Provider>
}

export function LanguagePicker({ compact }) {
  const { lang, setLang } = useT()
  return (
    <div className="lang-picker">
      {LANGS.map((l) => (
        <button key={l.code} className={lang === l.code ? 'on' : ''}
          onClick={() => setLang(l.code)}>
          {compact ? l.code.toUpperCase() : l.label}
        </button>
      ))}
    </div>
  )
}

// Inline SVG flags - emoji flags don't render on Windows, so tiny SVGs it is.
export function Flag({ code }) {
  if (code === 'fr') return (
    <svg viewBox="0 0 30 20" className="flag" aria-hidden="true">
      <rect width="10" height="20" fill="#0055A4" />
      <rect x="10" width="10" height="20" fill="#fff" />
      <rect x="20" width="10" height="20" fill="#EF4135" />
    </svg>
  )
  if (code === 'rw') return (
    <svg viewBox="0 0 30 20" className="flag" aria-hidden="true">
      <rect width="30" height="10" fill="#00A1DE" />
      <rect y="10" width="30" height="5" fill="#FAD201" />
      <rect y="15" width="30" height="5" fill="#20603D" />
      <circle cx="24" cy="5" r="2.6" fill="#E5BE01" />
    </svg>
  )
  return ( // en - simplified Union Jack
    <svg viewBox="0 0 30 20" className="flag" aria-hidden="true">
      <rect width="30" height="20" fill="#012169" />
      <path d="M0,0 L30,20 M30,0 L0,20" stroke="#fff" strokeWidth="4" />
      <path d="M0,0 L30,20 M30,0 L0,20" stroke="#C8102E" strokeWidth="1.8" />
      <path d="M15,0 V20 M0,10 H30" stroke="#fff" strokeWidth="6.5" />
      <path d="M15,0 V20 M0,10 H30" stroke="#C8102E" strokeWidth="3.5" />
    </svg>
  )
}

// Flag dropdown used on the public/login pages.
export function LanguageDropdown() {
  const { lang, setLang } = useT()
  const [open, setOpen] = useState(false)
  const current = LANGS.find((l) => l.code === lang) ?? LANGS[0]
  return (
    <div className="lang-dd">
      <button type="button" className="lang-dd-btn"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}>
        <Flag code={current.code} />
        {current.code.toUpperCase()}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 3.5 L5 7 L8.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="lang-dd-menu">
          {LANGS.map((l) => (
            <button type="button" key={l.code} className={l.code === lang ? 'on' : ''}
              onMouseDown={(e) => { e.preventDefault(); setLang(l.code); setOpen(false) }}>
              <Flag code={l.code} /> {l.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
