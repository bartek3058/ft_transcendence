import { useState, type FormEvent } from "react";
import { createTournament, type TournamentSize, type TournamentSummary } from "../../services/tournaments";

interface Props {
  onCreated: (tournament: TournamentSummary) => void;
  onCancel: () => void;
}
const sizes: TournamentSize[] = [2, 4, 8, 16, 32];
const codePoints = (value: string) => [...value].length;

export function CreateTournamentForm({ onCreated, onCancel }: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [maxParticipants, setMaxParticipants] = useState<TournamentSize>(8);
  const [deadline, setDeadline] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const cleanTitle = title.trim();
    const cleanDescription = description.trim();
    if (codePoints(cleanTitle) < 3 || codePoints(cleanTitle) > 64) {
      setError("Tournament name must contain 3–64 characters."); return;
    }
    if (codePoints(cleanDescription) > 255) {
      setError("Description must not exceed 255 characters."); return;
    }
    if (/[\p{Cc}]/u.test(cleanTitle + cleanDescription)) {
      setError("Control characters are not allowed."); return;
    }
    const invalidSurrogate = (s: string) => {
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = s.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        } else if (c >= 0xdc00 && c <= 0xdfff) return true;
      }
      return false;
    };
    if (invalidSurrogate(cleanTitle + cleanDescription)) {
      setError("Invalid text characters."); return;
    }
    const parsed = new Date(deadline);
    const lead = parsed.getTime() - Date.now();
    if (!deadline || !Number.isFinite(parsed.getTime())) {
      setError("Choose a valid registration deadline."); return;
    }
    if (lead < 5 * 60_000) {
      setError("Deadline must be at least 5 minutes from now."); return;
    }
    if (lead > 30 * 24 * 60 * 60_000) {
      setError("Deadline cannot be more than 30 days from now."); return;
    }
    setSubmitting(true);
    setError("");
    try {
      const created = await createTournament({
        title: cleanTitle,
        ...(cleanDescription ? { description: cleanDescription } : {}),
        maxParticipants,
        registrationDeadline: parsed.toISOString(),
      });
      onCreated(created);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create tournament.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card tournament-create" onSubmit={(event) => void submit(event)}>
      <h3>Create Tournament</h3>
      <label htmlFor="tournament-title">Tournament name</label>
      <input id="tournament-title" value={title} onChange={(e) => setTitle(e.target.value)}
        placeholder="Friday Chess Cup" required />
      <label htmlFor="tournament-description">Description (optional)</label>
      <textarea id="tournament-description" value={description}
        onChange={(e) => setDescription(e.target.value)} rows={3} />
      <label htmlFor="tournament-size">Maximum players</label>
      <select id="tournament-size" value={maxParticipants}
        onChange={(e) => setMaxParticipants(Number(e.target.value) as TournamentSize)}>
        {sizes.map((size) => <option key={size} value={size}>{size} players</option>)}
      </select>
      <label htmlFor="tournament-deadline">Registration deadline</label>
      <input id="tournament-deadline" type="datetime-local" value={deadline}
        onChange={(e) => setDeadline(e.target.value)} required />
      <small>Between 5 minutes and 30 days from now (your local time).</small>
      {error && <p className="tournament-error" role="alert">{error}</p>}
      <div className="tournament-form-actions">
        <button type="button" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button type="submit" className="primary" disabled={submitting}>
          {submitting ? "Creating..." : "Create Tournament"}
        </button>
      </div>
    </form>
  );
}
