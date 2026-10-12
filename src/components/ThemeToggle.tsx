import type { Theme } from "../state/theme";

interface Props {
  theme: Theme;
  onToggle: (origin: { x: number; y: number }) => void;
}

const RAYS = [0, 45, 90, 135, 180, 225, 270, 315];

/* Gradient ids are document-global; there is one toggle, so fixed names are safe. */
export function ThemeToggle({ theme, onToggle }: Props) {
  return (
    <button
      type="button"
      className="btn btn-icon theme-toggle"
      aria-label="Dark theme"
      aria-pressed={theme === "dark"}
      title={theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme"}
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        onToggle({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
      }}
    >
      <svg className="theme-sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <defs>
          <radialGradient id="theme-sun-core" cx="40%" cy="38%" r="65%">
            <stop offset="0%" stopColor="#fffbe0" />
            <stop offset="45%" stopColor="#ffd84a" />
            <stop offset="100%" stopColor="#ff9518" />
          </radialGradient>
          {/* User-space: a straight line has a zero-width bounding box, so a bounding-box gradient paints nothing. */}
          <linearGradient id="theme-sun-ray" gradientUnits="userSpaceOnUse" x1="12" y1="1.8" x2="12" y2="4.4">
            <stop offset="0%" stopColor="#ffe066" />
            <stop offset="100%" stopColor="#ff9a1f" />
          </linearGradient>
        </defs>
        <g className="theme-sun-rays">
          {RAYS.map((angle) => (
            <line
              key={angle}
              x1="12"
              y1="1.8"
              x2="12"
              y2="4.4"
              stroke="url(#theme-sun-ray)"
              strokeWidth="2"
              strokeLinecap="round"
              transform={`rotate(${angle} 12 12)`}
            />
          ))}
        </g>
        <circle cx="12" cy="12" r="5.2" fill="url(#theme-sun-core)" />
        <ellipse cx="10.2" cy="10" rx="1.9" ry="1.2" fill="#fff" opacity="0.75" transform="rotate(-35 10.2 10)" />
      </svg>

      <svg className="theme-moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="theme-moon-body" x1="0.15" y1="0.1" x2="0.85" y2="0.95">
            <stop offset="0%" stopColor="#f6f3ff" />
            <stop offset="50%" stopColor="#b8b6ff" />
            <stop offset="100%" stopColor="#6f7dff" />
          </linearGradient>
        </defs>
        <path
          d="M15.6 3.4A8.6 8.6 0 1 0 20.6 15a7 7 0 0 1-5-11.6Z"
          fill="url(#theme-moon-body)"
        />
        <path
          d="M10.2 5.6a6.6 6.6 0 0 0-3.6 4.6"
          stroke="#fff"
          strokeWidth="1.3"
          strokeLinecap="round"
          fill="none"
          opacity="0.7"
        />
        <path className="theme-star" d="M18.5 4.2l.55 1.35 1.35.55-1.35.55-.55 1.35-.55-1.35-1.35-.55 1.35-.55Z" fill="#fff" />
        <path className="theme-star" d="M21 9.6l.35.85.85.35-.85.35-.35.85-.35-.85-.85-.35.85-.35Z" fill="#fff" />
      </svg>
    </button>
  );
}
