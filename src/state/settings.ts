import { useCallback, useEffect, useState } from "react";
import { RANK_BANDS } from "../lib/positions";
import { DEFAULT_SETTINGS } from "../lib/scoring";
import type { RankBand, Settings } from "../types";

const STORAGE_KEY = "dotabuff-picker.settings.v1";

function read(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const num = (v: unknown, fallback: number, min: number, max: number) =>
      typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
    return {
      metaWeight: num(parsed.metaWeight, DEFAULT_SETTINGS.metaWeight, 0, 2),
      synergyWeight: num(parsed.synergyWeight, DEFAULT_SETTINGS.synergyWeight, 0, 3),
      laneWeight: num(parsed.laneWeight, DEFAULT_SETTINGS.laneWeight, 0, 4),
      minMatches: num(parsed.minMatches, DEFAULT_SETTINGS.minMatches, 0, 100_000),
      minSynergyMatches: num(
        parsed.minSynergyMatches,
        DEFAULT_SETTINGS.minSynergyMatches,
        0,
        50_000,
      ),
      minWinRate: num(parsed.minWinRate, DEFAULT_SETTINGS.minWinRate, 0, 60),
      minRoleFit: num(parsed.minRoleFit, DEFAULT_SETTINGS.minRoleFit, 0, 0.5),
      intentWeight: num(parsed.intentWeight, DEFAULT_SETTINGS.intentWeight, 0, 2),
      earlyWeight: num(parsed.earlyWeight, DEFAULT_SETTINGS.earlyWeight, 0, 6),
      rankBand: RANK_BANDS.includes(parsed.rankBand as RankBand)
        ? (parsed.rankBand as RankBand)
        : DEFAULT_SETTINGS.rankBand,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(read);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  const update = useCallback(
    <K extends keyof Settings>(key: K, value: Settings[K]) =>
      setSettings((prev) => ({ ...prev, [key]: value })),
    [],
  );

  const reset = useCallback(() => setSettings(DEFAULT_SETTINGS), []);

  return { settings, update, reset };
}
