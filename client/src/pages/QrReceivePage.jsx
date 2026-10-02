import { useEffect, useRef, useState } from 'react';
import Window from '../components/Window.jsx';
import Kw from '../components/Kw.jsx';
import Icon from '../components/Icon.jsx';
import { Link, setNavigationBlock } from '../router.jsx';
import { useSimple } from '../theme.js';
import { safeFileName, useWakeLock } from '../offline/wakeLock.js';
import { formatDuration, formatSize, formatSpeed } from '../utils.js';

const CAMERA = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30 },
  },
};

function cameraError(e) {
  if (!window.isSecureContext) return 'Камера доступна только по HTTPS.';
  if (!navigator.mediaDevices?.getUserMedia) return 'Этот браузер не даёт доступ к камере.';
  if (e?.name === 'NotAllowedError') return 'Нет доступа к камере. Разрешите его в настройках браузера и попробуйте снова.';
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return 'Камера не найдена.';
  if (e?.name === 'NotReadableError') return 'Камера занята другим приложением.';
  return `Не удалось включить камеру: ${e?.message || e}`;
}

export default function QrReceivePage() {
  const simple = useSimple();
  const [phase, setPhase] = useState('idle'); // idle | scanning | complete
  const [status, setStatus] = useState(null);
  const [storage, setStorage] = useState(null);
  const [error, setError] = useState('');
  const [rate, setRate] = useState({ fps: 0, bytes: 0 });
  const [result, setResult] = useState(null);
  const videoRef = useRef(null);
  const workerRef = useRef(null);
  const streamRef = useRef(null);
  const historyRef = useRef([]);

  useWakeLock(phase === 'scanning');

  useEffect(() => {
    setNavigationBlock(phase === 'scanning' && status?.manifest ? 'Прервать приём? Полученное сохранится, продолжить можно позже.' : null);
    return () => setNavigationBlock(null);
  }, [phase, status?.manifest]);

  // Worker lifetime = page lifetime.
  useEffect(() => {
    const worker = new Worker(new URL('../offline/scanner.worker.js', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'ready') setStorage(msg.storage);
      else if (msg.type === 'status') setStatus(msg);
      else if (msg.type === 'error') setError(`Ошибка обработки кадра: ${msg.message}`);
      else if (msg.type === 'complete') {
        setStatus(msg);
        setResult({ file: msg.file, name: safeFileName(msg.name), mime: msg.mime });
        setPhase('complete');
      }
    };
    worker.onerror = () => setError('Не удалось запустить распознавание. Обновите страницу.');
    worker.postMessage({ type: 'init' });
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };
  useEffect(() => stopCamera, []);

  const start = async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia(CAMERA);
      streamRef.current = stream;
      const [track] = stream.getVideoTracks();
      // Android: ask for continuous autofocus where supported; ignored elsewhere.
      track.applyConstraints?.({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      setPhase('scanning');
    } catch (e) {
      setError(cameraError(e));
    }
  };

  // Feed frames to the worker, one at a time (the worker answers "idle" when it can take the next one).
  useEffect(() => {
    if (phase !== 'scanning') return undefined;
    const video = videoRef.current;
    const worker = workerRef.current;
    video.srcObject = streamRef.current;
    video.play().catch(() => {});
    let busy = false;
    let stopped = false;
    let handle = 0;
    const onIdle = (event) => {
      if (event.data.type === 'idle') busy = false;
    };
    worker.addEventListener('message', onIdle);
    const schedule = () => {
      if (stopped) return;
      handle = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(pump) : requestAnimationFrame(pump);
    };
    const pump = async () => {
      if (!busy && video.readyState >= 2 && video.videoWidth > 0) {
        busy = true;
        try {
          const bitmap = await createImageBitmap(video);
          worker.postMessage({ type: 'frame', bitmap }, [bitmap]);
        } catch {
          busy = false;
        }
      }
      schedule();
    };
    schedule();
    return () => {
      stopped = true;
      if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
      worker.removeEventListener('message', onIdle);
    };
  }, [phase]);

  // Throughput over the last few seconds.
  useEffect(() => {
    if (!status) return;
    const now = performance.now();
    const h = historyRef.current;
    h.push({ t: now, decoded: status.decoded, bytes: status.symbols * (status.manifest?.blockLen || 0) });
    while (h.length > 2 && now - h[0].t > 4000) h.shift();
    const first = h[0];
    const dt = (now - first.t) / 1000;
    if (dt > 0.5) setRate({ fps: (status.decoded - first.decoded) / dt, bytes: (h[h.length - 1].bytes - first.bytes) / dt });
  }, [status]);

  useEffect(() => {
    if (phase === 'complete') stopCamera();
  }, [phase]);

  const save = async () => {
    const { file, name, mime } = result;
    const asFile = new File([file], name, { type: mime || 'application/octet-stream' });
    // iPhone: the share sheet is the way to "Save to Files"; elsewhere a plain download.
    if (/iphone|ipad|ipod/i.test(navigator.userAgent) && navigator.canShare?.({ files: [asFile] })) {
      try {
        await navigator.share({ files: [asFile] });
        return;
      } catch (e) {
        if (e?.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(asFile);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  const again = (discard) => {
    workerRef.current?.postMessage({ type: 'reset', discard });
    historyRef.current = [];
    setResult(null);
    setStatus(null);
    setPhase('idle');
  };

  const m = status?.manifest;
  const remaining = m ? m.size * (1 - status.progress) : 0;

  if (phase === 'complete' && result) {
    return (
      <Window title={simple ? 'Файл получен' : 'qr-receive — готово'}>
        <h1>{simple ? 'Файл получен' : 'Файл принят и проверен'}</h1>
        <p>
          <strong>{result.name}</strong> · {formatSize(m?.size ?? result.file.size)}
        </p>
        <p className="muted">Целостность проверена по SHA-256 каждого фрагмента.</p>
        <button type="button" className="btn btn-primary btn-block important" onClick={save}>
          Сохранить файл
        </button>
        <div className="qr-actions">
          <button type="button" className="btn btn-secondary" onClick={() => again(true)}>
            {storage === 'opfs' ? 'Удалить с устройства и принять другой' : 'Принять другой файл'}
          </button>
        </div>
      </Window>
    );
  }

  return (
    <Window title={simple ? 'Принять без интернета' : 'qr-receive'}>
      <h1>{simple ? 'Принять файл через QR' : 'Приём через камеру'}</h1>
      {phase === 'idle' && (
        <>
          <p className={simple ? '' : 'muted'}>
            {simple ? (
              <>
                Нажмите кнопку и <Kw>наведите камеру</Kw> на экран с QR-кодами.
              </>
            ) : (
              <>
                Наведите камеру на экран отправителя так, чтобы код целиком был в рамке. Можно начинать с любого
                момента и прерываться{storage === 'opfs' ? ' — полученные кадры сохраняются на устройстве' : ''}.
              </>
            )}
          </p>
          <button type="button" className="btn btn-primary btn-block important" onClick={start} disabled={!storage}>
            {storage ? 'Включить камеру' : 'Загрузка распознавателя…'}
          </button>
          {storage === 'memory' && (
            <p className="hint">Этот браузер не даёт хранилище OPFS: файл собирается в памяти, большие файлы могут не поместиться.</p>
          )}
        </>
      )}

      {phase === 'scanning' && (
        <>
          <div className="qr-viewfinder">
            <video ref={videoRef} playsInline muted autoPlay />
            <div className="qr-corners" aria-hidden="true" />
          </div>
          <div className="qr-receive-status" role="status">
            {m ? (
              <>
                <div className="qr-file">
                  <strong>{safeFileName(m.name)}</strong> · {formatSize(m.size)}
                </div>
                <div className="upload-stats">
                  <span className="upload-percent">{Math.floor(status.progress * 100)}%</span>
                  <span className="muted">
                    {formatSpeed(rate.bytes)}
                    {rate.bytes > 0 && ` · осталось ≈ ${formatDuration(remaining / rate.bytes)}`}
                  </span>
                </div>
                <div className="progress">
                  <div className="progress-bar active" style={{ width: `${status.progress * 100}%` }} />
                </div>
                {status.segmentsDone.length > 1 && (
                  <div className="qr-segments" aria-hidden="true">
                    {status.segmentsDone.map((d, i) => (
                      <i key={i} className={d ? 'done' : ''} />
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="qr-status-line">
                {status?.decoded ? 'Читаю описание файла…' : 'Ищу QR-код…'}
              </div>
            )}
            {status?.unsupportedVersion != null && (
              <p className="hint error">Отправитель использует более новую версию формата. Обновите приложение.</p>
            )}
            {!simple && status && (
              <div className="qr-stats">
                распознано {rate.fps.toFixed(1)} к/с · кадров {status.decoded}/{status.frames}
                {status.hashFailures > 0 && ` · перепроверено фрагментов: ${status.hashFailures}`}
              </div>
            )}
          </div>
          <div className="qr-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                stopCamera();
                setPhase('idle');
              }}
            >
              <Icon name="pause" />
              Пауза
            </button>
            <Link to="/offline" className="btn btn-secondary">
              <Icon name="back" />
              назад
            </Link>
          </div>
        </>
      )}

      {error && <p className="hint error">{error}</p>}
      {phase !== 'scanning' && (
        <div className="qr-actions">
          <Link to="/offline" className="btn btn-secondary">
            <Icon name="back" />
            назад
          </Link>
        </div>
      )}
    </Window>
  );
}
