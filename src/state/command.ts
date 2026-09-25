import { useCallback, useMemo, useState } from "react";
import {
  planCommand,
  type CommandContext,
  type CommandOutcome,
  type CommandRead,
} from "../lib/command";
import type { DraftState } from "../lib/draftState";
import type { BanSide, Hero, Slot } from "../types";

/** What the line under the search box says about a typed command. */
export interface CommandSummary {
  outcomes: CommandOutcome[];
  /** Words the command used that the picker could not place. */
  unknown: string[];
  /** Heroes left alone because the words around them could not be read. */
  held: string[];
}

export type CommandStatus =
  | ({ kind: "preview" } & CommandSummary)
  | ({ kind: "done"; canUndo: boolean } & CommandSummary);

interface Result extends CommandSummary {
  before: DraftState;
  after: DraftState;
}

interface Options {
  text: string;
  read: CommandRead;
  clearText: () => void;
  draft: DraftState;
  replace: (next: DraftState) => void;
  armed: Slot;
  banSide: BanSide;
  heroOf: (slug: string) => Hero | undefined;
}

export function useDraftCommand({
  text,
  read,
  clearText,
  draft,
  replace,
  armed,
  banSide,
  heroOf,
}: Options) {
  const [result, setResult] = useState<Result | null>(null);

  const note = text.trim();
  const context = useMemo<CommandContext>(() => ({ armed, banSide, heroOf }), [armed, banSide, heroOf]);
  const preview = useMemo(
    () => (read.isCommand && read.actions.length ? planCommand(draft, read.actions, context) : null),
    [read, draft, context],
  );
  const held = useMemo(
    () => read.held.map((slug) => heroOf(slug)?.name ?? slug),
    [read.held, heroOf],
  );
  // Only while the board is still the one the command left: undoing later would take other changes with it.
  const canUndo = result !== null && draft === result.after && result.after !== result.before;

  const undo = useCallback(() => {
    if (!result) return;
    replace(result.before);
    setResult(null);
  }, [result, replace]);

  /** Handles Enter when the text is a command; false leaves it to the plain search. */
  const enter = useCallback((): boolean => {
    if (!note) return false;
    if (note.toLowerCase() === "undo" && canUndo) {
      undo();
      clearText();
      return true;
    }
    if (!read.isCommand) return false;
    // Nothing understood yet: the text stays so a typo can be fixed in place.
    if (!read.actions.length) return true;
    const plan = planCommand(draft, read.actions, context);
    if (plan.changed) replace(plan.next);
    setResult({
      before: draft,
      after: plan.next,
      outcomes: plan.outcomes,
      unknown: read.unknown,
      held,
    });
    clearText();
    return true;
  }, [note, canUndo, undo, clearText, read, draft, context, replace, held]);

  let status: CommandStatus | null = null;
  if (note) {
    if (read.isCommand && (read.actions.length || read.unknown.length)) {
      status = { kind: "preview", outcomes: preview?.outcomes ?? [], unknown: read.unknown, held };
    }
  } else if (result && draft === result.after) {
    status = { kind: "done", outcomes: result.outcomes, unknown: result.unknown, held: result.held, canUndo };
  }

  return { status, enter, undo };
}
