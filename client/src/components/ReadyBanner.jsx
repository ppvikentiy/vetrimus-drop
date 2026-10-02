import { useState } from 'react';
import { filesLabel, formatDate } from '../utils.js';

function linkFor(session) {
  if (!session.token || session.pair || !session.key) return '';
  return `${window.location.origin}/${session.token}#${session.key}`;
}

export default function ReadyBanner({ sessions, deletingId, error, onDelete }) {
  const [copied, setCopied] = useState('');
  if (!sessions.length) return null;

  async function copy(session) {
    const link = linkFor(session);
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      return;
    }
    setCopied(session.dropId);
    setTimeout(() => setCopied((id) => (id === session.dropId ? '' : id)), 2500);
  }

  return (
    <div className="ready-list">
      {sessions.map((session) => {
        const link = linkFor(session);
        const names = session.files?.map((f) => f.name).filter(Boolean).join(', ');
        const when = session.expiresAt ? formatDate(session.expiresAt) : '';
        return (
          <div className="pair-banner ready-banner" key={session.dropId}>
            <div>
              <div>{session.pair ? 'Файлы на компьютере ещё хранятся.' : 'Ссылка ещё действует.'}{when ? ` До ${when}.` : ''}</div>
              <div className="muted small">Удалить можно около 6 часов — потом браузер забудет секрет.</div>
              {names && (
                <div className="muted small">
                  {filesLabel(session.files.length)}
                  {names ? ` · ${names}` : ''}
                </div>
              )}
            </div>
            {link && (
              <div className="link-row">
                <input className="input mono" readOnly value={link} aria-label="Ссылка" onFocus={(e) => e.target.select()} />
                <button type="button" className={`btn btn-secondary${copied === session.dropId ? ' copied' : ''}`} onClick={() => copy(session)}>
                  {copied === session.dropId ? '✓ Скопировано' : 'Копировать'}
                </button>
              </div>
            )}
            <div className="ready-actions">
              <button type="button" className="btn btn-secondary" onClick={() => onDelete(session)} disabled={deletingId === session.dropId}>
                {deletingId === session.dropId ? 'Удаляем…' : 'Удалить ссылку'}
              </button>
            </div>
          </div>
        );
      })}
      {error && <div className="alert alert-error">{error}</div>}
    </div>
  );
}
