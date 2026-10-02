import { Link } from '../router.jsx';
import { isStandalone } from '../pwa.js';
import { setConsent, useConsent } from '../consent.js';

export default function ConsentBar() {
  const choice = useConsent();
  if (isStandalone() || choice === 'accepted') return null;
  const declined = choice === 'declined';

  return (
    <div className="consent" role="dialog" aria-label="Политика обработки данных">
      <p>
        {declined ? (
          'Функции передачи файлов отключены, пока политика не принята.'
        ) : (
          <>
            Продолжая, вы подтверждаете, что ознакомились с{' '}
            <Link to="/policy">Политикой обработки данных</Link>.
          </>
        )}
      </p>
      <div className="consent-actions">
        <button type="button" className="btn btn-primary" onClick={() => setConsent('accepted')}>
          Принять
        </button>
        {!declined && (
          <button type="button" className="btn btn-secondary" onClick={() => setConsent('declined')}>
            Отклонить
          </button>
        )}
      </div>
    </div>
  );
}
