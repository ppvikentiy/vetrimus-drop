import Window from '../components/Window.jsx';
import { Link } from '../router.jsx';
import { setTheme, useSimple } from '../theme.js';
import Icon from '../components/Icon.jsx';
import Kw from '../components/Kw.jsx';

const PRIVACY = [
  [
    'Токен ссылки — 256 бит случайности, его невозможно подобрать.',
    'Адрес раздачи — 32 случайных байта, в ссылке это 43 символа. Вариантов больше, чем 10⁷⁷, перебор нереален. Часть после # браузер на сервер не отправляет: там ключ шифрования. Без полной ссылки раздачу не найти и файлы не открыть.',
  ],
  [
    'В базе хранятся только хэши токенов и паролей — даже с доступом к БД ссылку не восстановить.',
    'В базе лежит SHA-256 от токена, а не сам токен. Пароль — scrypt-хэш со случайной солью, секрет загрузки тоже только в виде хэша. По копии базы ссылку не собрать и пароль не узнать. Настоящие имена файлов зашифрованы в браузере, в базе остаются обезличенные file-N.',
  ],
  [
    'Файлы лежат в изолированном S3-хранилище и удаляются по сроку или лимиту.',
    'Содержимое идёт потоком сразу в отдельный бакет и на диск сервера не записывается. В бакете только шифртекст. Когда срок выходит или скачивания заканчиваются, фоновая задача примерно раз в 10 минут удаляет файлы из хранилища и запись из базы. Вернуть их нельзя.',
  ],
  [
    'Никаких аккаунтов, профилей и истории загрузок.',
    'Регистрации нет, сервер не знает, кто вы. Нет профиля, списка ваших раздач и истории получателей. Ограничения по частоте считаются по IP и не привязаны к человеку. Незаконченная загрузка запоминается только в вашем браузере и пропадает примерно через 6 часов.',
  ],
  [
    'Код открыт — его можно прочитать и сверить с сайтом.',
    'Клиент, сервер и передача через QR опубликованы. По коду видно, что файлы шифруются в браузере, а сервер получает только шифртекст.',
    'https://github.com/ppvikentiy/vetrimus-drop',
  ],
];

const FEATURES = [
  [
    'Сквозное шифрование',
    'Файлы и их названия шифруются прямо в вашем браузере. Ключ хранится только в ссылке (в части после #) и на сервер не попадает — даже владелец сервера не может прочитать ваши файлы.',
  ],
  [
    'До 10 файлов по 500 МБ',
    'Любые форматы. Перетащите в окно, выберите кнопкой или вставьте через Ctrl+V. Для каждого файла видны прогресс, скорость и оставшееся время.',
  ],
  [
    'Срок хранения',
    '1, 3, 7 или 30 дней с момента создания ссылки. Когда срок выходит, файлы удаляются из хранилища в течение 10 минут — восстановить их нельзя. Ссылку можно удалить раньше: кнопка есть сразу после отправки и ещё около 6 часов.',
  ],
  [
    'Лимит скачиваний',
    '1, 5, 10 или любое число до 1000. Докачка после обрыва и скачивание нескольких файлов с одной страницы считаются одним скачиванием.',
  ],
  [
    'Пароль',
    'Дополнительный замок: без пароля страница не откроется. Файлы и так зашифрованы ключом из ссылки — пароль защищает от того, у кого ссылка есть, но пароля нет. После 20 неверных попыток за 15 минут ввод блокируется.',
  ],
  [
    'Ссылка и QR-код',
    'Ссылка содержит случайный адрес и ключ шифрования после #. Копируйте её целиком — без конца файл не открыть. QR-код можно показать с экрана или сохранить картинкой.',
  ],
  [
    'ZIP или по одному',
    'Получатель скачивает всё одним ZIP-архивом или каждый файл отдельно. Одиночный файл докачивается, если связь оборвалась.',
  ],
  [
    'Миниатюры фото и видео',
    'Превью создаются в вашем браузере, шифруются вместе с файлами и видны получателю только по ссылке с ключом. Сервер их не видит.',
  ],
  [
    'С телефона на компьютер без ссылки',
    'Откройте на компьютере «Принять с телефона» — появится QR-код. Наведите на него камеру телефона: файлы зашифруются и сами откроются на компьютере, сервер их не видит.',
  ],
  [
    'Без интернета — через QR',
    'Один файл до 256 МБ передаётся потоком QR-кодов с экрана на камеру другого телефона. Сеть не нужна, приём можно прервать и продолжить.',
  ],
  [
    'Приложение на телефон',
    'Устанавливается на Android, iPhone и компьютер. На Android файлы можно отправить прямо из галереи через «Поделиться». В Chrome на Android отправка продолжается, даже если закрыть приложение.',
  ],
];

const STEPS = [
  ['загрузите', 'Выберите или перетащите до 10 файлов.'],
  ['настройте', 'Срок хранения, лимит скачиваний и, по желанию, пароль.'],
  ['поделитесь', 'Скопируйте ссылку или покажите QR-карточку получателю.'],
];

const LIMITS = [
  ['файлов в раздаче', 'до 10'],
  ['размер файла', 'до 500 МБ'],
  ['срок хранения', '1д · 3д · 7д · 30д'],
  ['скачиваний', '1 · 5 · 10 · своё (до 1000)'],
  ['пароль', 'по желанию'],
  ['несколько файлов', 'ZIP или по одному'],
];

function SimpleHome() {
  return (
    <div className="simple-home">
      <h1>Отправить файлы по ссылке</h1>
      <ol className="simple-steps">
        <li>
          <Kw>Выберите файлы</Kw>
        </li>
        <li>
          Укажите <Kw>срок</Kw> и <Kw>число скачиваний</Kw>
        </li>
        <li>
          <Kw>Отправьте ссылку</Kw> получателю
        </li>
      </ol>
      <Link to="/upload" className="btn btn-primary btn-block important">
        Отправить файлы
      </Link>
      <Link to="/receive" className="btn btn-secondary btn-block">
        Принять файлы с телефона
      </Link>
      <Link to="/offline" className="btn btn-secondary btn-block">
        Передать без интернета
      </Link>
      <p className="muted">Файлы удаляются сами, когда закончится срок.</p>
    </div>
  );
}

export default function HomePage() {
  const simple = useSimple();
  const host = window.location.host;
  if (simple) return <SimpleHome />;

  return (
    <div className="home">
      <section className="hero">
        <div className="hero-text">
          <div className="eyebrow">// передача файлов без регистрации</div>
          <h1 className="hero-title">
            Отправьте файлы
            <br />
            одной ссылкой<span className="cursor" aria-hidden="true" />
          </h1>
          <p className="hero-lead">
            Загрузите до 10 файлов, задайте срок жизни и лимит скачиваний — и отправьте ссылку или QR-код. Когда срок
            выйдет, файлы исчезнут сами.
          </p>
          <div className="hero-actions">
            <Link to="/upload" className="btn btn-primary">
              $ ./upload
            </Link>
            <Link to="/receive" className="btn btn-secondary">
              $ ./receive
            </Link>
            <a href="#how" className="btn btn-secondary">
              как это работает
            </a>
          </div>
          <button type="button" className="simple-entry" onClick={() => setTheme('simple')}>
            <span className="simple-entry-icon" aria-hidden="true">
              <Icon name="simple" size={16} />
            </span>
            Упрощённый режим — крупный текст, без анимаций, пошаговые подсказки
          </button>
        </div>

        <Window title="bash — drop" className="hero-term" aria-hidden="true">
          <div className="typed">
            <div className="term-line">
              <span className="prompt">$</span> drop push отчёт.pdf фото.zip \
            </div>
            <div className="term-line indent">--expire 7d --limit 5 --password</div>
            <div className="term-line muted">
              отчёт.pdf <span className="bar">[████████████████]</span> 100%
            </div>
            <div className="term-line muted">
              фото.zip&nbsp; <span className="bar">[████████████████]</span> 100%
            </div>
            <div className="term-line">
              <span className="ok">✓</span> {host}/k3Jx9QmR…
            </div>
            <div className="term-line muted">&nbsp; срок: 7 дней · скачиваний: 0/5 · пароль: да</div>
            <div className="term-line">
              <span className="prompt">$</span> <span className="cursor" />
            </div>
          </div>
        </Window>
      </section>

      <section className="section">
        <h2 className="section-heading">
          <span className="hash">##</span> возможности
        </h2>
        <div className="features">
          {FEATURES.map(([title, text], i) => (
            <div className="feature spot" key={title} style={{ '--i': i }}>
              <div className="feature-num">[{String(i + 1).padStart(2, '0')}]</div>
              <div className="feature-title">{title}</div>
              <div className="feature-text">{text}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="section" id="how">
        <h2 className="section-heading">
          <span className="hash">##</span> как это работает
        </h2>
        <ol className="steps">
          {STEPS.map(([title, text], i) => (
            <li className="step spot" key={title} style={{ '--i': i }}>
              <div className="step-num">0{i + 1}</div>
              <div>
                <div className="step-title">{title}</div>
                <div className="step-text">{text}</div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="section section-split">
        <div>
          <h2 className="section-heading">
            <span className="hash">##</span> лимиты
          </h2>
          <table className="term-table">
            <tbody>
              {LIMITS.map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <h2 className="section-heading">
            <span className="hash">##</span> приватность
          </h2>
          <div className="term-list">
            {PRIVACY.map(([title, detail, url]) => (
              <details key={title}>
                <summary>{title}</summary>
                <p>
                  {detail}
                  {url && (
                    <>
                      {' '}
                      <a href={url} target="_blank" rel="noreferrer">
                        github.com/ppvikentiy/vetrimus-drop
                      </a>
                    </>
                  )}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="cta spot">
        <div className="cta-text">
          <span className="prompt">$</span> готовы отправить файлы?
        </div>
        <Link to="/upload" className="btn btn-primary">
          $ ./upload
        </Link>
      </section>
    </div>
  );
}
