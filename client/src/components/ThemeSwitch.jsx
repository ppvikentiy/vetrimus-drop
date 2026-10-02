import { setTheme, useTheme } from '../theme.js';
import Icon from './Icon.jsx';

const OPTIONS = [
  { value: 'dark', label: 'Тёмная', icon: 'moon' },
  { value: 'light', label: 'Светлая', icon: 'sun' },
  { value: 'simple', label: 'Упрощённая', icon: 'simple' },
];

export default function ThemeSwitch() {
  const theme = useTheme();
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Оформление">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={theme === o.value}
          className={`theme-option theme-${o.value}${theme === o.value ? ' active' : ''}`}
          title={o.value === 'simple' ? 'Упрощённый режим: крупный текст, без анимаций' : `${o.label} тема`}
          onClick={() => setTheme(o.value)}
        >
          <Icon name={o.icon} size={20} />
          <span className="theme-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
