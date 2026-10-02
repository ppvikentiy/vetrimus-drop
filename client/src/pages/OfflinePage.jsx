import Window from '../components/Window.jsx';
import Kw from '../components/Kw.jsx';
import { Link } from '../router.jsx';
import { useSimple } from '../theme.js';
import { useInstall } from '../pwa.js';

export default function OfflinePage() {
  const simple = useSimple();
  const install = useInstall();
  return (
    <Window title={simple ? 'Без интернета' : 'qr-drop — передача без сети'}>
      <h1>{simple ? 'Передать файл без интернета' : 'Передача через QR-коды'}</h1>
      {simple ? (
        <p>
          Один телефон <Kw>показывает</Kw> QR-коды, другой <Kw>снимает</Kw> их камерой.
        </p>
      ) : (
        <p className="muted">
          Файл превращается в поток QR-кодов на экране отправителя, получатель считывает их камерой. Интернет не нужен
          ни одной из сторон — достаточно один раз открыть Drop с подключением. Кадры можно пропускать, начинать с
          середины и прерываться: полученное сохраняется, а недостающее досчитывается из следующих кадров.
        </p>
      )}
      <div className="offline-choice">
        <Link to="/offline/send" className="btn btn-primary important">
          {simple ? 'Отправить файл' : '$ ./qr-send'}
        </Link>
        <Link to="/offline/receive" className="btn btn-secondary important">
          {simple ? 'Принять файл' : '$ ./qr-receive'}
        </Link>
      </div>
      {!simple && (
        <ul className="offline-notes muted">
          <li>Один файл до 256 МБ; комфортно — до 150 МБ.</li>
          <li>Скорость зависит от камеры и экрана: от десятков до сотен КБ/с.</li>
          <li>Без шифрования: всё, что видно на экране, может снять любая камера рядом.</li>
        </ul>
      )}
      {!install.standalone && (
        <p className="hint">
          {simple ? 'Установите приложение, чтобы оно открывалось без интернета.' : 'Установите Drop как приложение — так режим QR надёжно откроется без сети.'}
        </p>
      )}
    </Window>
  );
}
