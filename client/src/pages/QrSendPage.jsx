import { useEffect, useRef, useState } from 'react';
import { MAX_FILE_SIZE, createSender, fromBlob } from 'vqd';
import Window from '../components/Window.jsx';
import Kw from '../components/Kw.jsx';
import Icon from '../components/Icon.jsx';
import { Link, setNavigationBlock } from '../router.jsx';
import { useSimple } from '../theme.js';
import { PROFILES, drawQr } from '../offline/qr.js';
import { useWakeLock } from '../offline/wakeLock.js';
import { formatDuration, formatSize, formatSpeed } from '../utils.js';

const RATES = [5, 10, 15, 20, 30];

export default function QrSendPage() {
  const simple = useSimple();
  const [file, setFile] = useState(null);
  const [profileId, setProfileId] = useState('max');
  const [fps, setFps] = useState(10);
  const [phase, setPhase] = useState('select'); // select | preparing | sending
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [shown, setShown] = useState(0);
  const senderRef = useRef(null);
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const inputRef = useRef(null);
  const profile = PROFILES.find((p) => p.id === profileId);

  useWakeLock(phase === 'sending' && !paused);

  useEffect(() => {
    setNavigationBlock(phase === 'sending' ? 'Остановить показ QR-кодов?' : null);
    return () => setNavigationBlock(null);
  }, [phase]);

  const pick = (f) => {
    setError('');
    if (!f) return;
    if (f.size === 0) return setError('Файл пустой.');
    if (f.size > MAX_FILE_SIZE) return setError(`Файл больше ${formatSize(MAX_FILE_SIZE)} — через QR его не передать.`);
    setFile(f);
  };

  const start = async () => {
    setPhase('preparing');
    setError('');
    try {
      senderRef.current = await createSender({
        source: fromBlob(file),
        name: file.name,
        mime: file.type || 'application/octet-stream',
        frameBytes: profile.frameBytes,
      });
      setShown(0);
      setPaused(false);
      setPhase('sending');
    } catch (e) {
      setError(`Не удалось подготовить файл: ${e.message}`);
      setPhase('select');
    }
  };

  const stop = () => {
    senderRef.current = null;
    setPhase('select');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };

  // Frame loop: one QR code every 1/fps seconds.
  useEffect(() => {
    if (phase !== 'sending' || paused) return undefined;
    const sender = senderRef.current;
    let cancelled = false;
    let timer = 0;
    let due = performance.now();
    let count = 0;
    const tick = async () => {
      if (cancelled) return;
      const bytes = await sender.nextFrame();
      if (cancelled || !canvasRef.current) return;
      drawQr(canvasRef.current, bytes, profile.version);
      count++;
      if (count % 5 === 0) setShown(sender.framesSent);
      due += 1000 / fps;
      const now = performance.now();
      if (due < now) due = now; // fell behind: do not try to catch up with a burst
      timer = setTimeout(tick, due - now);
    };
    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, paused, fps, profile.version]);

  const fullscreen = () => {
    const el = stageRef.current;
    if (el?.requestFullscreen) el.requestFullscreen().catch(() => {});
  };

  if (phase === 'sending') {
    const s = senderRef.current;
    const blocks = Math.ceil(s.manifest.fileSize / s.blockLen);
    const rate = fps * s.blockLen;
    return (
      <div className="qr-send">
        <div className="qr-stage" ref={stageRef} onDoubleClick={fullscreen}>
          <canvas ref={canvasRef} className="qr-canvas" aria-label="Анимированный QR-код с файлом" />
        </div>
        <div className="qr-send-info">
          <div className="qr-file">
            <strong>{file.name}</strong> · {formatSize(file.size)}
          </div>
          <div className="muted">
            {simple ? (
              <>Наведите камеру второго телефона на код. Держите экран включённым до конца приёма.</>
            ) : (
              <>
                {fps} кадров/с · {formatSpeed(rate)} · минимум ≈ {formatDuration(blocks / fps)} · показано кадров: {shown}
              </>
            )}
          </div>
          <div className="chips" role="group" aria-label="Скорость">
            {RATES.map((r) => (
              <button key={r} type="button" className={`chip${r === fps ? ' active' : ''}`} onClick={() => setFps(r)}>
                {r} к/с
              </button>
            ))}
          </div>
          <div className="qr-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setPaused((p) => !p)}>
              <Icon name={paused ? 'play' : 'pause'} />
              {paused ? 'Продолжить' : 'Пауза'}
            </button>
            {document.fullscreenEnabled && (
              <button type="button" className="btn btn-secondary" onClick={fullscreen}>
                <Icon name="maximize" />
                Во весь экран
              </button>
            )}
            <button type="button" className="btn btn-secondary" onClick={stop}>
              <Icon name="stop" />
              Остановить
            </button>
          </div>
          <p className="hint">
            Если получатель долго не набирает прогресс — уменьшите скорость или выберите плотность «{PROFILES[2].label}».
          </p>
        </div>
      </div>
    );
  }

  return (
    <Window title={simple ? 'Отправить без интернета' : 'qr-send'}>
      <h1>{simple ? 'Отправить файл через QR' : 'Отправка через QR-коды'}</h1>
      <p className={simple ? '' : 'muted'}>
        {simple ? (
          <>
            Выберите <Kw>один файл</Kw>, затем покажите экран камере получателя.
          </>
        ) : (
          <>Один файл до {formatSize(MAX_FILE_SIZE)}. Получателю нужно открыть «Принять через QR» в Drop на своём телефоне.</>
        )}
      </p>
      <button
        type="button"
        className="dropzone"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          pick(e.dataTransfer.files?.[0]);
        }}
      >
        <div className="dropzone-title">{file ? file.name : 'Выбрать файл'}</div>
        <div className="muted">{file ? formatSize(file.size) : 'или перетащите сюда'}</div>
      </button>
      <input ref={inputRef} type="file" hidden onChange={(e) => pick(e.target.files?.[0])} />

      <div className="setting">
        <div className="setting-label">{simple ? 'Плотность кода' : <><span className="flag">--density</span> плотность кода</>}</div>
        <div className="chips">
          {PROFILES.map((p) => (
            <button key={p.id} type="button" className={`chip${p.id === profileId ? ' active' : ''}`} onClick={() => setProfileId(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="hint">{profile.hint}</div>
      </div>

      <div className="setting">
        <div className="setting-label">{simple ? 'Скорость' : <><span className="flag">--fps</span> кадров в секунду</>}</div>
        <div className="chips">
          {RATES.map((r) => (
            <button key={r} type="button" className={`chip${r === fps ? ' active' : ''}`} onClick={() => setFps(r)}>
              {r}
            </button>
          ))}
        </div>
        {file && (
          <div className="hint">
            ≈ {formatSpeed(fps * (profile.frameBytes - 18))}, минимум {formatDuration(file.size / (fps * (profile.frameBytes - 18)))} при
            идеальном приёме
          </div>
        )}
      </div>

      {error && <p className="hint error">{error}</p>}
      <button type="button" className="btn btn-primary btn-block important" disabled={!file || phase === 'preparing'} onClick={start}>
        {phase === 'preparing' ? 'Подготовка…' : 'Показать QR-коды'}
      </button>
      <div className="qr-actions">
        <Link to="/offline" className="btn btn-secondary">
          <Icon name="back" />
          назад
        </Link>
      </div>
    </Window>
  );
}
