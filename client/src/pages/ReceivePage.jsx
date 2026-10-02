import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { createPairing, deletePairing, getPairingStatus } from '../api.js';
import Window from '../components/Window.jsx';
import Kw from '../components/Kw.jsx';
import Icon from '../components/Icon.jsx';
import { Link, navigate } from '../router.jsx';
import { useSimple } from '../theme.js';
import { formatPairCode, formatSize } from '../utils.js';

const STORE_KEY = 'vd-pairing';
const POLL_MS = 2000;

const readStored = () => {
  try {
    return JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
  } catch {
    return null;
  }
};
const writeStored = (value) => {
  try {
    if (value) sessionStorage.setItem(STORE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(STORE_KEY);
  } catch {
    // private mode: reloading the page simply asks for a new code
  }
};

// Computer side of pairing: shows a short code (and a QR for the phone's camera) and opens the
// download page by itself once the phone has finished uploading.
export default function ReceivePage() {
  const simple = useSimple();
  const [pairing, setPairing] = useState(null); // { code, secret }
  const [status, setStatus] = useState({ state: 'waiting' });
  const [error, setError] = useState('');
  const pairingRef = useRef(null);
  const failures = useRef(0);

  const start = useCallback(async () => {
    setError('');
    setStatus({ state: 'waiting' });
    failures.current = 0;
    try {
      const { code, secret } = await createPairing();
      // The decryption key is generated here, on the computer, and shown only inside the QR code.
      // The phone reads it from the scanned link; the server never receives it.
      const { generateMasterKey, keyToString } = await import('../crypto/vde.js');
      const key = keyToString(generateMasterKey());
      const next = { code, secret, key };
      writeStored(next);
      pairingRef.current = next;
      setPairing(next);
    } catch (e) {
      setError(e.message);
      setPairing(null);
    }
  }, []);

  useEffect(() => {
    const stored = readStored();
    if (stored) {
      pairingRef.current = stored;
      setPairing(stored);
    } else {
      start();
    }
    // Free the held link if the person leaves before the phone is done with the code.
    return () => {
      const p = pairingRef.current;
      if (p) {
        writeStored(null);
        deletePairing(p.code, p.secret).catch(() => {});
      }
    };
  }, [start]);

  useEffect(() => {
    if (!pairing) return undefined;
    let stopped = false;
    const tick = async () => {
      try {
        const s = await getPairingStatus(pairing.code, pairing.secret);
        if (stopped) return;
        failures.current = 0;
        setStatus(s);
        if (s.state === 'ready') {
          await deletePairing(pairing.code, pairing.secret).catch(() => {});
          writeStored(null);
          pairingRef.current = null;
          // The key never went to the server; the computer had it all along and opens the file with it.
          navigate(`/${s.token}${pairing.key ? `#${pairing.key}` : ''}`);
        }
      } catch (e) {
        if (stopped) return;
        if (e.status === 404) {
          // expired, or taken over: a new code is needed
          writeStored(null);
          pairingRef.current = null;
          setPairing(null);
          setStatus({ state: 'expired' });
        } else if (++failures.current >= 3) {
          setError(e.message);
        }
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [pairing]);

  // The QR carries the code and, in its fragment, the encryption key for the phone to use.
  const link = pairing ? `${window.location.origin}/p/${pairing.code}${pairing.key ? `#${pairing.key}` : ''}` : '';
  const uploading = status.state === 'uploading';
  const percent = uploading && status.totalSize > 0 ? Math.floor((status.uploadedBytes / status.totalSize) * 100) : 0;

  return (
    <Window title={simple ? 'Принять с телефона' : '~/receive'}>
      <div>
        <h1>{simple ? 'Принять файлы с телефона' : 'Приём с телефона'}</h1>
        {simple ? (
          <ol className="simple-steps">
            <li>
              Откройте на телефоне <Kw>Vetrimus Drop</Kw>
            </li>
            <li>
              Наведите на <Kw>QR-код</Kw> камеру телефона
            </li>
            <li>
              Выберите файлы — они появятся <Kw>здесь</Kw>
            </li>
          </ol>
        ) : (
          <p className="muted">
            Наведите камеру телефона на QR-код. Файлы зашифруются на телефоне и появятся здесь сразу после загрузки — сервер их содержимого не увидит.
          </p>
        )}
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      {uploading ? (
        <div className="upload-progress" role="status">
          <div className="section-title">Телефон отправляет файлы…</div>
          <div className="upload-stats">
            <span className="upload-percent">{percent}%</span>
            <span className="muted">
              {formatSize(status.uploadedBytes)} / {formatSize(status.totalSize)} · файлов: {status.fileCount}
            </span>
          </div>
          <div className="progress">
            <div className="progress-bar active" style={{ width: `${percent}%` }} />
          </div>
          <p className="hint">Не закрывайте эту страницу — она сама откроет файлы, когда загрузка закончится.</p>
        </div>
      ) : pairing ? (
        <div className="pair-box">
          <div className="pair-qr" aria-label="QR-код для телефона">
            <QRCodeSVG value={link} size={176} marginSize={2} />
          </div>
          <div className="pair-code-block">
            <div className="muted">{simple ? 'Код для проверки' : 'код'}</div>
            <div className="pair-code">{formatPairCode(pairing.code)}</div>
            <div className="hint">
              Наведите камеру телефона на QR-код. Действует 10 минут
              {status.secondsLeft != null && status.state === 'waiting' && ` · осталось ${Math.floor(status.secondsLeft / 60)}:${String(status.secondsLeft % 60).padStart(2, '0')}`}
            </div>
          </div>
        </div>
      ) : (
        status.state === 'expired' && (
          <div className="alert" role="status">
            Код устарел.
          </div>
        )
      )}

      {!pairing && !uploading && (
        <button type="button" className="btn btn-primary important" onClick={start}>
          Получить новый код
        </button>
      )}
      <div className="qr-actions">
        <Link to="/home" className="btn btn-secondary">
          <Icon name="back" />
          назад
        </Link>
      </div>
    </Window>
  );
}
