import type { CommandStatus as Status } from "../state/command";

interface CommandStatusProps {
  status: Status;
  onUndo: () => void;
}

const quote = (words: string[]) => words.map((w) => `“${w}”`).join(", ");

const list = (names: string[]) =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;

/** What Enter will do with a typed draft command, or what it just did. */
export function CommandStatus({ status, onUndo }: CommandStatusProps) {
  const { outcomes, unknown, held } = status;
  return (
    <p className="command-status">
      {status.kind === "preview" && outcomes.length > 0 && <kbd>Enter</kbd>}
      {outcomes.map((outcome, i) => (
        <span key={`${outcome.slug}-${i}`} className={`command-outcome ${outcome.tone ? "" : "muted"}`}>
          {outcome.tone && outcome.tone !== "removed" && (
            <span className={`dot dot-${outcome.tone}`} aria-hidden />
          )}
          {outcome.text}
        </span>
      ))}
      {unknown.length > 0 && (
        <span className="muted">
          Didn't recognize {quote(unknown)}
          {held.length > 0 ? `, so nothing happens to ${list(held)}` : ""}
        </span>
      )}
      {status.kind === "done" && status.canUndo && (
        <button type="button" className="link-btn" onClick={onUndo}>
          Undo
        </button>
      )}
    </p>
  );
}
