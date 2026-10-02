import { useState } from 'react';
import Icon from './Icon.jsx';
import { useInstall } from '../pwa.js';
import { useSimple } from '../theme.js';
import { Link } from '../router.jsx';

const SOURCE_URL = 'https://github.com/ppvikentiy/vetrimus-drop';

/* global __APP_VERSION__, __BUILD_TYPE__, __BUILD_NUMBER__, __BUILD_COMMIT__ */
const BUILD = {
  version: __APP_VERSION__,
  type: __BUILD_TYPE__,
  number: __BUILD_NUMBER__,
  commit: __BUILD_COMMIT__,
};

function BuildInfo({ simple }) {
  const title = `Версия ${BUILD.version}, тип сборки ${BUILD.type}, билд ${BUILD.number}${BUILD.commit ? `, коммит ${BUILD.commit}` : ''}`;
  if (simple) {
    return (
      <span className="build-info" title={title}>
        Версия {BUILD.version} · {BUILD.type} · билд {BUILD.number}
      </span>
    );
  }
  return (
    <span className="build-info" title={title}>
      v{BUILD.version} · {BUILD.type} · билд {BUILD.number}
      {BUILD.commit ? ` · ${BUILD.commit}` : ''}
    </span>
  );
}

export default function Footer() {
  const simple = useSimple();
  const install = useInstall();
  const [iosOpen, setIosOpen] = useState(false);

  return (
    <footer className="footer">
      <div className="footer-main">
        <span>
          {simple ? 'Приватно. Безопасно. Конфиденциально.' : '// приватно. безопасно. конфиденциально.'}
        </span>
        <Link to="/policy" className="btn btn-secondary footer-policy">
          Политика обработки данных
        </Link>
        {install.canPrompt && (
          <button type="button" className="footer-link" onClick={install.prompt}>
            Установить приложение
          </button>
        )}
        {install.iosHint && (
          <button type="button" className="footer-link" aria-expanded={iosOpen} onClick={() => setIosOpen((v) => !v)}>
            Установить приложение
          </button>
        )}
      </div>
      <div className="footer-end">
        <BuildInfo simple={simple} />
        <a className="footer-github" href={SOURCE_URL} target="_blank" rel="noreferrer" aria-label="Исходный код на GitHub">
          <Icon name="github" size={18} />
        </a>
      </div>
      {iosOpen && (
        <div className="footer-hint" role="note">
          В Safari нажмите «Поделиться» (квадрат со стрелкой), затем «На экран „Домой“».
        </div>
      )}
    </footer>
  );
}
