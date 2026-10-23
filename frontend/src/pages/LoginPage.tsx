import { FormEvent, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (user) return <Navigate to="/profile" replace />;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login(email.trim().toLowerCase(), password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from || "/profile", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to log in.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-shell">
      <section className="auth-card">
        <div className="auth-brand">
          ♞ <b>ChessHub</b>
        </div>
        <h1>Log in</h1>
        <p>Enter the game and continue your matches.</p>
        <form onSubmit={submit} className="auth-form">
          <label>
            Email
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}
          <button className="auth-submit" disabled={busy}>
            {busy ? "Logging in…" : "Log in"}
          </button>
        </form>
        <div className="auth-switch">
          Don't have an account? <Link to="/register">Sign up</Link>
        </div>
      </section>
    </div>
  );
}
