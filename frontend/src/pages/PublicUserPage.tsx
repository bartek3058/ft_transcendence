import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { friendsApi, type PublicUser } from "../services/friends";
export function PublicUserPage() {
  const { id } = useParams();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setUser(null);
    setError("");
    if (id)
      void friendsApi
        .profile(id)
        .then((data) => {
          if (!cancelled) setUser(data.user);
        })
        .catch((e) => {
          if (!cancelled)
            setError(e instanceof Error ? e.message : "Profile unavailable");
        });
    return () => {
      cancelled = true;
    };
  }, [id]);
  return (
    <div className="friends-page">
      <Link to="/friends">← Back to friends</Link>
      <section className="friends-panel friends-public">
        <h1>Player profile</h1>
        {error ? (
          <p role="alert">{error}</p>
        ) : user ? (
          <>
            <div className="friends-avatar">
              {user.username.slice(0, 2).toUpperCase()}
            </div>
            <h2>{user.username}</h2>
            <p>Rating: {user.rating}</p>
          </>
        ) : (
          <p>Loading...</p>
        )}
      </section>
    </div>
  );
}
