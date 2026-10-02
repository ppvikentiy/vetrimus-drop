import { useRef, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import Window from './Window.jsx';
import Kw from './Kw.jsx';
import { useSimple } from '../theme.js';
import { downloadsLabel, filesLabel, formatDate, formatSize } from '../utils.js';

export default function SharePanel({ result, onReset, onDelete, deleting, deleteError }) {
  const simple = useSimple();
  const [tab, setTab] = useState('link');
  const [copied, setCopied] = useState(false);
  const qrRef = useRef(null);
  // The decryption key lives only in the link fragment (#…); it never reaches the server.
  const link = `${window.location.origin}/${result.token}${result.key ? `#${result.key}` : ''}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      const input = document.getElementById('share-link');
      input?.select();
      document.execCommand('copy');
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  function saveQr() {
    const canvas = qrRef.current;
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `vetrimus-drop-${result.token.slice(0, 8)}.png`;
    a.click();
  }

  const summary = `${filesLabel(result.fileCount)} · ${formatSize(result.totalSize)} · до ${formatDate(result.expiresAt)}`;
  const limits = `${downloadsLabel(result.maxDownloads)}${result.hasPassword ? ' · с паролем' : ''}`;

  const linkRow = (
    <div className="link-row">
      <input id="share-link" className="input mono" readOnly value={link} aria-label="Ссылка" onFocus={(e) => e.target.select()} />
      <button className={`btn btn-primary${copied ? ' copied' : ''}${simple ? ' important' : ''}`} onClick={copy}>
        {copied ? '✓ Скопировано' : simple ? 'Копировать ссылку' : 'Копировать'}
      </button>
    </div>
  );

  const qr = (
    <div className="qr-frame">
      <QRCodeCanvas ref={qrRef} value={link} size={simple ? 200 : 184} marginSize={2} level="M" />
    </div>
  );

  if (simple) {
    return (
      <Window title="~/upload — готово">
        <div>
          <h1>Готово!</h1>
          <p>
            <Kw>Отправьте ссылку</Kw> получателю
          </p>
        </div>
        {linkRow}
        {copied ? (
          <div className="hint" role="status">
            Скопировано — <Kw>вставьте в сообщение</Kw>
          </div>
        ) : (
          result.key && (
            <div className="hint">
              Копируйте <Kw>всю ссылку</Kw> — без конца файл не открыть
            </div>
          )
        )}
        <ul className="plain-list">
          <li>
            Действует <Kw>до {formatDate(result.expiresAt)}</Kw>
          </li>
          <li>
            Скачиваний: <Kw>{result.maxDownloads}</Kw>
          </li>
          {result.hasPassword && (
            <li>
              Нужен <Kw>пароль</Kw>
            </li>
          )}
        </ul>
        <div className="qr-card">
          {qr}
          <button className="btn btn-secondary" onClick={saveQr}>
            Сохранить QR-код
          </button>
        </div>
        {onDelete && (
          <button type="button" className="btn btn-secondary btn-block" onClick={onDelete} disabled={deleting}>
            {deleting ? 'Удаляем…' : 'Удалить ссылку'}
          </button>
        )}
        {deleteError && <div className="alert alert-error">{deleteError}</div>}
        {onDelete && !deleting && (
          <div className="hint">Файлы будут стёрты сразу. Если закрыть страницу, кнопка останется ещё около 6 часов.</div>
        )}
        <button className="btn btn-secondary btn-block" onClick={onReset}>
          Отправить ещё
        </button>
      </Window>
    );
  }


  return (
    <Window title="~/upload — готово">
      <div className="success">
        <div className="success-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <h1>Раздача создана</h1>
        <p className="muted">Отправьте ссылку или QR-код получателю.</p>
      </div>

      <div className="tabs" role="tablist" data-active={tab}>
        <span className="tabs-indicator" aria-hidden="true" />
        <button role="tab" aria-selected={tab === 'link'} className={`tab${tab === 'link' ? ' active' : ''}`} onClick={() => setTab('link')}>
          Ссылка
        </button>
        <button role="tab" aria-selected={tab === 'qr'} className={`tab${tab === 'qr' ? ' active' : ''}`} onClick={() => setTab('qr')}>
          QR-код
        </button>
      </div>

      {tab === 'link' ? (
        <div className="share-link fade-in" key="link">
          {linkRow}
          {typeof navigator.share === 'function' && (
            <button className="btn btn-secondary btn-block" onClick={() => navigator.share({ url: link }).catch(() => {})}>
              Отправить…
            </button>
          )}
          <div className="meta-row">
            <span>{summary}</span>
            <span className="muted">{limits}</span>
          </div>
          {result.key && (
            <div className="hint">
              Файлы зашифрованы в вашем браузере. Ключ — в конце ссылки (после #): копируйте её целиком, иначе
              получатель не сможет открыть файлы. Сервер ключ не видит.
            </div>
          )}
        </div>
      ) : (
        <div className="qr-card fade-in" key="qr">
          {qr}
          <div className="qr-caption">{summary}</div>
          <div className="qr-caption muted">{limits}</div>
          <button className="btn btn-secondary" onClick={saveQr}>
            Сохранить PNG
          </button>
        </div>
      )}

      {onDelete && (
        <button type="button" className="btn btn-secondary btn-block" onClick={onDelete} disabled={deleting}>
          {deleting ? 'Удаляем…' : 'Удалить ссылку'}
        </button>
      )}
      {deleteError && <div className="alert alert-error">{deleteError}</div>}
      {onDelete && !deleting && (
        <div className="hint">Файлы будут стёрты сразу. Если закрыть страницу, кнопка останется ещё около 6 часов.</div>
      )}
      <button className="btn btn-link btn-block" onClick={onReset}>
        Новая раздача
      </button>
    </Window>
  );
}
