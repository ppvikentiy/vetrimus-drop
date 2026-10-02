import { useEffect, useState } from 'react';
import HomePage from './pages/HomePage.jsx';
import UploadPage from './pages/UploadPage.jsx';
import DropPage from './pages/DropPage.jsx';
import OfflinePage from './pages/OfflinePage.jsx';
import ReceivePage from './pages/ReceivePage.jsx';
import QrSendPage from './pages/QrSendPage.jsx';
import QrReceivePage from './pages/QrReceivePage.jsx';
import PolicyPage from './pages/PolicyPage.jsx';
import Window from './components/Window.jsx';
import ThemeSwitch from './components/ThemeSwitch.jsx';
import Kw from './components/Kw.jsx';
import Footer from './components/Footer.jsx';
import ConsentBar from './components/ConsentBar.jsx';
import { Link } from './router.jsx';
import { useSimple, useTheme } from './theme.js';
import { isStandalone, useOnline } from './pwa.js';
import { setConsent, useConsent } from './consent.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function currentPath() {
  let path = window.location.pathname.replace(/\/+$/, '');
  if (path === '') {
    window.history.replaceState(null, '', '/home');
    path = '/home';
  }
  // The installed app opens on the upload page. A drop link, pairing code or QR page stays put.
  if (isStandalone() && path === '/home' && navigator.onLine !== false) {
    window.history.replaceState(null, '', '/upload');
    return '/upload';
  }
  // A pairing QR/link (/p/CODE#key) opens the upload page in "send to the computer" mode. The key
  // stays in the fragment so it never reaches the server.
  const pair = /^\/p\/([^/]+)$/.exec(path);
  if (pair) {
    window.history.replaceState(null, '', `/upload?pair=${pair[1]}${window.location.hash}`);
    return '/upload';
  }
  // Installed app opened with no network: link upload cannot work, QR transfer can.
  if (isStandalone() && navigator.onLine === false && !path.startsWith('/offline')) {
    const shared = new URLSearchParams(window.location.search).has('shared');
    if (!shared) {
      window.history.replaceState(null, '', '/offline');
      return '/offline';
    }
  }
  return path;
}

export default function App() {
  const [path, setPath] = useState(currentPath);
  const simple = useSimple();
  const theme = useTheme();
  const online = useOnline();
  const consent = useConsent();
  const logoSrc = theme === 'dark' ? '/icons/logo-white.png' : '/icons/logo-black.png';
  const blocked = !isStandalone() && consent === 'declined' && isTransferPath(path);
  const showConsent = !isStandalone() && consent !== 'accepted';

  useEffect(() => {
    const onPop = () => setPath(currentPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Soft cursor-following highlight on cards (.spot reads --mx/--my).
  useEffect(() => {
    if (simple) return;
    const onMove = (e) => {
      const el = e.target instanceof Element ? e.target.closest('.spot') : null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [simple]);

  const segment = decodeURIComponent(path.slice(1));
  let page;
  if (path === '/home') page = <HomePage />;
  else if (path === '/upload') page = <UploadPage />;
  else if (path === '/receive') page = <ReceivePage />;
  else if (path === '/offline') page = <OfflinePage />;
  else if (path === '/offline/send') page = <QrSendPage />;
  else if (path === '/offline/receive') page = <QrReceivePage />;
  else if (path === '/policy') page = <PolicyPage />;
  else if (TOKEN_RE.test(segment)) page = <DropPage key={segment} token={segment} />;
  else page = <NotFound path={path} />;

  return (
    <div className={`app${showConsent ? ' has-consent' : ''}`}>
      {!online && (
        <div className="offline-banner" role="status">
          Нет подключения к интернету — ссылки сейчас не работают, но файл можно{' '}
          <Link to="/offline">передать через QR-коды</Link>.
        </div>
      )}
      <header className="header">
        <Link to="/home" className="logo">
          <img className="logo-mark" src={logoSrc} width="44" height="44" alt="" />
          <span className="logo-text">vetrimus-drop</span>
        </Link>
        <div className="header-right">
          <nav className="nav">
            <Link to="/home" className={path === '/home' ? 'active' : ''}>
              {simple ? 'Главная' : 'home'}
            </Link>
            <Link to="/upload" className={path === '/upload' ? 'active' : ''}>
              {simple ? 'Отправить файлы' : 'upload'}
            </Link>
            <Link to="/receive" className={path === '/receive' ? 'active' : ''}>
              {simple ? 'Принять' : 'receive'}
            </Link>
            <Link to="/offline" className={path.startsWith('/offline') ? 'active' : ''}>
              {simple ? 'Без интернета' : 'qr'}
            </Link>
          </nav>
          <ThemeSwitch />
        </div>
      </header>
      <main key={path} className={`main${path === '/home' ? ' main-wide' : ''}`}>
        {blocked ? <ConsentBlocked /> : page}
      </main>
      <Footer />
      <ConsentBar />
    </div>
  );
}

function isTransferPath(path) {
  if (path === '/upload' || path === '/receive' || path.startsWith('/offline')) return true;
  return TOKEN_RE.test(decodeURIComponent(path.slice(1)));
}

function ConsentBlocked() {
  const simple = useSimple();
  return (
    <Window title={simple ? 'Функции отключены' : 'policy'}>
      <h1>Функции отключены</h1>
      <p>Передача и получение файлов недоступны, пока не принята политика обработки данных.</p>
      <div className="consent-actions">
        <button type="button" className="btn btn-primary" onClick={() => setConsent('accepted')}>
          Принять
        </button>
        <Link to="/policy" className="btn btn-secondary footer-policy">
          Политика обработки данных
        </Link>
      </div>
    </Window>
  );
}

function NotFound({ path }) {
  const simple = useSimple();
  return (
    <Window title="error">
      {simple ? (
        <>
          <h1>Такой страницы нет</h1>
          <p>
            <Kw>Проверьте ссылку</Kw>
          </p>
        </>
      ) : (
        <>
          <div className="term-line">
            <span className="prompt">$</span> cd {path}
          </div>
          <div className="term-error">bash: cd: {path}: нет такой страницы</div>
        </>
      )}
      <Link className="btn btn-primary important" to="/upload">
        {simple ? 'Отправить файлы' : 'Загрузить файлы'}
      </Link>
    </Window>
  );
}
