import moon from '../icons/moon.svg?raw';
import sun from '../icons/sun.svg?raw';
import simple from '../icons/a-large-small.svg?raw';
import back from '../icons/arrow-left.svg?raw';
import pause from '../icons/pause.svg?raw';
import play from '../icons/play.svg?raw';
import maximize from '../icons/maximize.svg?raw';
import stop from '../icons/circle-stop.svg?raw';
import github from '../icons/github.svg?raw';

// Lucide icons (ISC), kept as SVG assets in src/icons.
const ICONS = { moon, sun, simple, back, pause, play, maximize, stop, github };

export default function Icon({ name, size = 18 }) {
  return (
    <span
      className={`icon icon-${name}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}
