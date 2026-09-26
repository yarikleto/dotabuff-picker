import { useCallback, useEffect, useState } from "react";
import {
  addPoolHero,
  clearPools,
  readRolePools,
  togglePoolHero,
  type RolePools,
} from "../lib/rolePools";
import type { Position } from "../types";

const STORAGE_KEY = "dotabuff-picker.role-pools.v1";

function read(): RolePools {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return readRolePools(raw ? JSON.parse(raw) : null);
  } catch {
    return readRolePools(null);
  }
}

/** What the last clear removed, kept until the next change so it can be put back. */
export interface ClearedPools {
  before: RolePools;
  position: Position | null;
}

export function useRolePools() {
  const [pools, setPools] = useState<RolePools>(read);
  const [cleared, setCleared] = useState<ClearedPools | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pools));
    } catch {
      /* persistence is a nicety */
    }
  }, [pools]);

  const toggle = useCallback((position: Position, slug: string) => {
    setCleared(null);
    setPools((prev) => togglePoolHero(prev, position, slug));
  }, []);

  const add = useCallback((position: Position, slug: string) => {
    setCleared(null);
    setPools((prev) => addPoolHero(prev, position, slug));
  }, []);

  const clear = useCallback(
    (position: Position | null) => {
      setCleared({ before: pools, position });
      setPools(clearPools(pools, position));
    },
    [pools],
  );

  const undoClear = useCallback(() => {
    if (!cleared) return;
    setPools(cleared.before);
    setCleared(null);
  }, [cleared]);

  return { pools, toggle, add, clear, cleared, undoClear };
}
