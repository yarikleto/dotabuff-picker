import { useEffect, useState } from "react";
import { cdnPortrait, localPortrait } from "../lib/dataset";
import type { Hero } from "../types";

/**
 * Portraits are tried locally first (`npm run images`), then from
 * Valve's CDN, and finally fall back to the hero's initials — the board must
 * stay usable offline and before any scrape has run.
 */
export function HeroPortrait({ hero, className }: { hero: Hero; className?: string }) {
  const [stage, setStage] = useState<0 | 1 | 2>(0);

  useEffect(() => setStage(0), [hero.slug]);

  if (stage === 2) {
    const initials = hero.name
      .split(/[\s'-]+/)
      .map((w) => w[0] ?? "")
      .join("")
      .slice(0, 3)
      .toUpperCase();
    return (
      <span className={`portrait portrait-fallback attr-${hero.attr} ${className ?? ""}`} aria-hidden>
        {initials}
      </span>
    );
  }

  return (
    <img
      className={`portrait ${className ?? ""}`}
      src={stage === 0 ? localPortrait(hero) : cdnPortrait(hero)}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setStage((s) => (s === 0 ? 1 : 2))}
    />
  );
}
