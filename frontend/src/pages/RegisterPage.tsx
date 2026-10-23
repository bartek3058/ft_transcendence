import { FormEvent, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

function validate(username: string, password: string, confirm: string) {
  const u = username.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(u))
    return "Username: 3–20 characters, only a-z, 0-9 and _.";
  if (Array.from(password).length < 15)
    return "Password must be at least 15 characters long.";
  if (Array.from(password).length > 128)
    return "Password can be up to 128 characters long.";
  if (new TextEncoder().encode(password).length > 512)
    return "Password is too long.";
  if (password !== confirm) return "Passwords do not match.";
  return "";
}
export function RegisterPage() {
  const { user, register } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  if (user) return <Navigate to="/" replace />;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess("");
    const validation = validate(username, password, confirm);
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    try {
      await register(
        email.trim().toLowerCase(),
        username.trim().toLowerCase(),
        password,
      );
      setSuccess("Account created.You can now log in.");
      setTimeout(() => navigate("/login", { replace: true }), 900);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to create account.",
      );
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
        <h1>Create account</h1>
        <p>Your public username will be saved in lowercase.</p>
        <form onSubmit={submit} className="auth-form">
          <label>
            E-mail
            <input
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Username
            <input
              type="text"
              autoComplete="username"
              required
              minLength={3}
              maxLength={20}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <small>
              Minimum 15 characters. Spaces are part of the password.
            </small>
          </label>
          <label>
            Confirm password
            <input
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}
          {success && <div className="auth-success">{success}</div>}
          <button className="auth-submit" disabled={busy}>
            {busy ? "Creating account…" : "Sign up"}
          </button>
        </form>
        <div className="auth-switch">
          Already have an account? <Link to="/login">Log in</Link>
        </div>
      </section>
    </div>
  );
}
