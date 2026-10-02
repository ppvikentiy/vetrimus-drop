import { useEffect, useState } from 'react';
import { downloadUrl, fileUrl, getDrop, thumbUrl, unlockDrop } from '../api.js';
import { downloadEncrypted } from '../download.js';
import FileList from '../components/FileList.jsx';
import Window from '../components/Window.jsx';
import Kw from '../components/Kw.jsx';
import { Link } from '../router.jsx';
import { useSimple } from '../theme.js';
import { downloadsLabel, filesLabel, formatDate, formatSize } from '../utils.js';

// The decryption key for an end-to-end encrypted drop travels in the link fragment (…#key); the
// browser keeps it out of every request, so the server never receives it.
function readKey() {
  const raw = window.location.hash.replace(/^#/, '');
  return raw || null;
}

export default function DropPage({ token }) {
  const simple = useSimple();
  const [state, setState] = useState({ status: 'loading' });
  const [password, setPassword] = useState('');
  const [unlockError, setUnlockError] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [busy, setBusy] = useState(null); // { progress } while decrypting in-memory (fallback)
  const title = `~/drop/${token.slice(0, 8)}…`;
  const linkKey = readKey();

  // Turns a server response into a ready/needKey state, decrypting the metadata for encrypted drops.
  async function toReady(data) {
    if (!data.enc) {
      return { status: 'ready', info: { enc: false, ...data }, key: data.accessKey };
    }
    const vde = await import('../crypto/vde.js');
    const master = vde.keyFromString(linkKey);
    if (!master) return { status: 'needKey' };
    let meta;
    try {
      meta = await vde.decryptMetadata(master, vde.base64ToBytes(data.meta));
    } catch {
      return { status: 'needKey' };
    }
    const files = meta.files.map((f, i) => ({
      name: f.name,
      size: f.size,
      type: f.type || 'application/octet-stream',
      thumb: f.thumb || null,
      cipherSize: data.files[i]?.size ?? 0,
    }));
    return {
      status: 'ready',
      info: { enc: true, files, totalSize: files.reduce((s, f) => s + f.size, 0), expiresAt: data.expiresAt, downloadsLeft: data.downloadsLeft },
      key: data.accessKey,
      master: linkKey,
    };
  }

  useEffect(() => {
    getDrop(token)
      .then(async (data) => setState(data.requiresPassword ? { status: 'locked', enc: data.enc } : await toReady(data)))
      .catch((err) => setState({ status: 'error', message: err.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function unlock(e) {
    e.preventDefault();
    if (!password || unlocking) return;
    setUnlocking(true);
    setUnlockError('');
    try {
      const data = await unlockDrop(token, password);
      setState(await toReady(data));
    } catch (err) {
      if (err.status === 404) setState({ status: 'error', message: err.message });
      else setUnlockError(err.message);
    } finally {
      setUnlocking(false);
    }
  }

  function onDownload() {
    setState((s) => (s.started ? s : { ...s, started: true, info: { ...s.info, downloadsLeft: s.info.downloadsLeft - 1 } }));
  }

  // Encrypted download: either the whole drop (ZIP for several files) or one file.
  async function startEncrypted(only) {
    const { info, key, master } = state;
    const chosen = only != null ? [info.files[only]] : info.files;
    const plan = {
      token,
      accessKey: key,
      master,
      files: chosen.map((f) => ({ index: info.files.indexOf(f), name: f.name, type: f.type, cipherSize: f.cipherSize, plainSize: f.size })),
      zipName: only == null && info.files.length > 1 ? `vetrimus-drop-${token.slice(0, 8)}.zip` : undefined,
    };
    onDownload();
    try {
      const { streamed } = await downloadEncrypted(plan, { onProgress: (p) => setBusy({ progress: p }) });
      setBusy(null);
      if (!streamed) return; // fallback already triggered the save
    } catch (err) {
      setBusy(null);
      setState((s) => ({ ...s, downloadError: err.message || 'Не удалось расшифровать файл' }));
    }
  }

  if (state.status === 'loading') {
    return (
      <Window title={title}>
        <div className="term-line muted">
          {simple ? 'Загрузка…' : 'загрузка'}
          <span className="cursor" aria-label="Загрузка" />
        </div>
      </Window>
    );
  }

  if (state.status === 'error') {
    return (
      <Window title={title}>
        <h1>Файлы недоступны</h1>
        <div className="alert alert-error">{state.message}</div>
        {simple && (
          <p>
            Попросите <Kw>новую ссылку</Kw>
          </p>
        )}
        <Link className="btn btn-primary" to="/upload">
          {simple ? 'Отправить свои файлы' : 'Загрузить свои файлы'}
        </Link>
      </Window>
    );
  }

  if (state.status === 'needKey') {
    return (
      <Window title={title}>
        <h1>Ссылка неполная</h1>
        <p className="muted">
          {simple ? (
            <>
              Файлы зашифрованы. Нужна <Kw>вся ссылка</Kw> целиком — попросите прислать её ещё раз.
            </>
          ) : (
            <>
              Эти файлы зашифрованы, а ключ находится в конце ссылки — после знака «#». Скорее всего ссылку скопировали
              не полностью. Попросите отправителя прислать её целиком.
            </>
          )}
        </p>
        <Link className="btn btn-primary" to="/upload">
          Отправить свои файлы
        </Link>
      </Window>
    );
  }

  if (state.status === 'locked') {
    return (
      <Window as="form" title={title} onSubmit={unlock}>
        <div className="lock-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="5" y="11" width="14" height="9" rx="2.5" />
            <path d="M8 11V8a4 4 0 018 0v3" strokeLinecap="round" />
          </svg>
        </div>
        <div className="center-text">
          <h1>{simple ? 'Нужен пароль' : 'Раздача защищена паролем'}</h1>
          <p className="muted">
            {simple ? (
              <>
                Его сообщил <Kw>отправитель</Kw>
              </>
            ) : (
              'Введите пароль, чтобы увидеть файлы.'
            )}
          </p>
        </div>
        <input
          className={`input${unlockError ? ' invalid shake' : ''}`}
          key={unlockError}
          type="password"
          placeholder="Пароль"
          aria-label="Пароль"
          autoFocus
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {unlockError && (
          <div className="hint error" role="alert">
            {unlockError}
          </div>
        )}
        <button className={`btn btn-primary btn-block${simple ? ' important' : ''}`} disabled={!password || unlocking}>
          {unlocking ? 'Проверка…' : 'Открыть'}
        </button>
      </Window>
    );
  }

  const { info, key, started } = state;
  const enc = info.enc;
  const multiple = info.files.length > 1;
  const canDownload = info.downloadsLeft > 0 || started;
  const left = Math.max(info.downloadsLeft, 0);

  const fileEntry = (f, i) => ({
    key: i,
    name: f.name,
    size: f.size,
    thumb: enc ? f.thumb : f.thumb ? thumbUrl(token, key, i) : null,
    href: !enc && multiple && canDownload ? fileUrl(token, key, i) : null,
    onClick: enc && multiple && canDownload ? () => startEncrypted(i) : null,
    onDownload,
  });

  return (
    <Window title={title}>
      <div>
        <h1>{multiple ? 'Вам отправили файлы' : 'Вам отправили файл'}</h1>
        <p className="muted">
          {filesLabel(info.files.length)} · {formatSize(info.totalSize)}
          {enc && (simple ? '' : ' · зашифровано')}
        </p>
      </div>

      <FileList files={info.files.map(fileEntry)} />

      {simple ? (
        <ul className="plain-list">
          <li>
            Действует <Kw>до {formatDate(info.expiresAt)}</Kw>
          </li>
          <li>
            Осталось скачиваний: <Kw>{left}</Kw>
          </li>
        </ul>
      ) : (
        <div className="meta-row">
          <span>
            <span className="muted">до</span> {formatDate(info.expiresAt)}
          </span>
          <span>
            <span className="muted">осталось</span> {downloadsLabel(left)}
          </span>
        </div>
      )}

      {canDownload ? (
        enc ? (
          <button
            type="button"
            className={`btn btn-primary btn-block${simple ? ' important' : ''}`}
            disabled={busy != null}
            onClick={() => startEncrypted(null)}
          >
            {busy != null
              ? `Расшифровка… ${Math.floor((busy.progress || 0) * 100)}%`
              : multiple
                ? simple
                  ? 'Скачать всё'
                  : 'Скачать всё одним ZIP'
                : 'Скачать'}
          </button>
        ) : (
          <a className={`btn btn-primary btn-block${simple ? ' important' : ''}`} href={downloadUrl(token, key)} onClick={onDownload}>
            {multiple ? (simple ? 'Скачать всё' : 'Скачать всё одним ZIP') : 'Скачать'}
          </a>
        )
      ) : (
        <div className="alert">Лимит скачиваний исчерпан — ссылка больше не активна.</div>
      )}

      {state.downloadError && (
        <div className="hint error" role="alert">
          {state.downloadError}
        </div>
      )}

      {enc && !simple && (
        <div className="hint center-text">Файлы расшифровываются прямо в вашем браузере. Сервер их содержимого не видит.</div>
      )}

      {started && !state.downloadError && (
        <div className="hint center-text fade-in" role="status">
          <span className="ok">✓</span>{' '}
          {simple ? (
            <>
              Файл появится в «<Kw>Загрузках</Kw>»
            </>
          ) : (
            'скачивание началось'
          )}
          {!simple && (info.downloadsLeft <= 0 ? ' — это было последнее скачивание.' : '.')}
        </div>
      )}
    </Window>
  );
}
