import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  FriendsApiError,
  friendsApi,
  type Friend,
  type FriendRequest,
  type Page,
  type PublicUser,
} from "../services/friends";
import { useFriendsConnection } from "../context/FriendsContext";

function Avatar({ name }: { name: string }) {
  return (
    <span className="friends-avatar" aria-hidden="true">
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}
function Person({ user, online }: { user: PublicUser; online?: boolean }) {
  return (
    <div className="friends-person">
      <Avatar name={user.username} />
      <div>
        <Link to={`/users/${user.id}`}>{user.username}</Link>
        <small>
          Rating {user.rating}
          {online !== undefined ? ` · ${online ? "Online" : "Offline"}` : ""}
        </small>
      </div>
    </div>
  );
}
function More({
  page,
  onClick,
  disabled,
}: {
  page: Page<unknown> | null;
  onClick: () => void;
  disabled: boolean;
}) {
  return page?.hasMore ? (
    <button className="friends-more" disabled={disabled} onClick={onClick}>
      Load more
    </button>
  ) : null;
}
export function FriendsPage() {
  const navigate = useNavigate();
  const { connected, revision, retry } = useFriendsConnection();
  const [friends, setFriends] = useState<Page<Friend> | null>(null);
  const [requests, setRequests] = useState<Page<FriendRequest> | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Page<PublicUser> | null>(null);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const seq = useRef(0);
  const searchSeq = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++seq.current;
    try {
      const [f, r] = await Promise.all([
        friendsApi.friends(),
        friendsApi.requests(),
      ]);
      if (current === seq.current) {
        setFriends(f);
        setRequests(r);
        setError("");
      }
    } catch (e) {
      if (current === seq.current) {
        if (e instanceof FriendsApiError && e.status === 401)
          navigate("/login");
        else
          setError(e instanceof Error ? e.message : "Unable to load friends");
      }
    } finally {
      if (current === seq.current) setLoading(false);
    }
  }, [navigate]);
  useEffect(() => {
    void refresh();
    return () => {
      seq.current++;
    };
  }, [refresh, revision]);
  useEffect(() => {
    const q = query.trim().toLowerCase();
    const requestId = ++searchSeq.current;
    if (q.length < 3) {
      setResults(null);
      setSearching(false);
      return;
    }
    setResults(null);
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const data = await friendsApi.search(q);
        if (!cancelled && requestId === searchSeq.current) {
          setResults(data);
          setError("");
        }
      } catch (e) {
        if (!cancelled && requestId === searchSeq.current)
          setError(e instanceof Error ? e.message : "Search failed");
      } finally {
        if (!cancelled && requestId === searchSeq.current) setSearching(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);
  async function action(
    key: string,
    run: () => Promise<unknown>,
    success: string,
  ) {
    setBusy(key);
    setError("");
    setMessage("");
    try {
      await run();
      setMessage(success);
      await refresh();
      if (query.trim().length >= 3)
        setResults(await friendsApi.search(query.trim().toLowerCase()));
    } catch (e) {
      if (e instanceof FriendsApiError && e.status === 401) navigate("/login");
      else {
        setError(
          e instanceof FriendsApiError && e.status === 429
            ? `${e.message}. Try again in ${e.retryAfter ?? "a few"} seconds.`
            : e instanceof Error
              ? e.message
              : "Action failed",
        );
        if (e instanceof FriendsApiError && [404, 409].includes(e.status))
          await refresh();
      }
    } finally {
      setBusy(null);
    }
  }
  async function loadMore<T>(
    current: Page<T> | null,
    getter: (offset: number) => Promise<Page<T>>,
    setter: (v: Page<T>) => void,
  ) {
    if (!current?.hasMore || busy) return;
    setBusy("more");
    try {
      const next = await getter(current.offset + current.limit);
      setter({ ...next, items: [...current.items, ...next.items] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load more");
    } finally {
      setBusy(null);
    }
  }
  const incoming =
    requests?.items.filter((r) => r.direction === "incoming") ?? [];
  const outgoing =
    requests?.items.filter((r) => r.direction === "outgoing") ?? [];
  const related = new Set([
    ...(friends?.items.map((f) => f.user.id) ?? []),
    ...(requests?.items.map((r) => r.user.id) ?? []),
  ]);
  return (
    <div className="friends-page">
      <div className="friends-heading">
        <div>
          <h1>Friends</h1>
          <p>Find players, manage invitations and see who's online.</p>
        </div>
      </div>
      {error && (
        <div className="friends-alert" role="alert">
          {error}
          <button
            onClick={() => {
              setError("");
              void refresh();
            }}
          >
            Retry
          </button>
        </div>
      )}
      {message && (
        <div className="friends-notice" role="status">
          {message}
        </div>
      )}
      <div className="friends-grid">
        <section className="friends-panel">
          <h2>Find players</h2>
          <label htmlFor="friends-search">Search by username</label>
          <input
            id="friends-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={20}
            placeholder="At least 3 characters"
          />
          {query.trim().length < 3 ? (
            <p className="friends-muted">Enter at least 3 characters.</p>
          ) : searching ? (
            <p className="friends-muted">Searching...</p>
          ) : results?.items.length === 0 ? (
            <p className="friends-muted">No players found.</p>
          ) : (
            <div className="friends-list">
              {results?.items.map((user) => (
                <div className="friends-item" key={user.id}>
                  <Person user={user} />
                  {related.has(user.id) ? (
                    <span className="friends-muted">
                      Already connected or invited
                    </span>
                  ) : (
                    <button
                      disabled={busy !== null}
                      onClick={() =>
                        void action(
                          user.id,
                          () => friendsApi.send(user.id),
                          "Invitation sent",
                        )
                      }
                    >
                      Add friend
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <More
            page={results}
            disabled={busy !== null}
            onClick={() =>
              void loadMore(
                results,
                (offset) =>
                  friendsApi.search(query.trim().toLowerCase(), offset),
                setResults,
              )
            }
          />
        </section>
        <section className="friends-panel">
          <h2>
            My friends{" "}
            <span>
              {friends?.items.length ?? 0}
              {friends?.hasMore ? "+" : ""}
            </span>
          </h2>
          {loading ? (
            <p className="friends-muted">Loading...</p>
          ) : !friends?.items.length ? (
            <p className="friends-muted">
              No friends yet. Search for someone to invite.
            </p>
          ) : (
            <div className="friends-list">
              {friends.items.map((friend) => (
                <div className="friends-item" key={friend.friendshipId}>
                  <Person
                    user={friend.user}
                    online={connected ? friend.user.online : undefined}
                  />
                  <button
                    className="friends-danger"
                    disabled={busy !== null}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Remove ${friend.user.username} from friends?`,
                        )
                      )
                        void action(
                          friend.user.id,
                          () => friendsApi.remove(friend.user.id),
                          "Friend removed",
                        );
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          <More
            page={friends}
            disabled={busy !== null}
            onClick={() =>
              void loadMore(friends, friendsApi.friends, setFriends)
            }
          />
        </section>
        <section className="friends-panel">
          <h2>
            Incoming requests <span>{incoming.length}</span>
          </h2>
          {!incoming.length ? (
            <p className="friends-muted">No incoming invitations.</p>
          ) : (
            <div className="friends-list">
              {incoming.map((req) => (
                <div className="friends-item" key={req.id}>
                  <Person user={req.user} />
                  <div className="friends-actions">
                    <button
                      disabled={busy !== null}
                      onClick={() =>
                        void action(
                          req.id,
                          () => friendsApi.accept(req.id),
                          "Invitation accepted",
                        )
                      }
                    >
                      Accept
                    </button>
                    <button
                      className="friends-danger"
                      disabled={busy !== null}
                      onClick={() =>
                        void action(
                          req.id,
                          () => friendsApi.decline(req.id),
                          "Invitation declined",
                        )
                      }
                    >
                      Decline
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="friends-panel">
          <h2>
            Sent requests <span>{outgoing.length}</span>
          </h2>
          {!outgoing.length ? (
            <p className="friends-muted">No pending outgoing invitations.</p>
          ) : (
            <div className="friends-list">
              {outgoing.map((req) => (
                <div className="friends-item" key={req.id}>
                  <Person user={req.user} />
                  <button
                    className="friends-danger"
                    disabled={busy !== null}
                    onClick={() =>
                      void action(
                        req.id,
                        () => friendsApi.decline(req.id),
                        "Invitation cancelled",
                      )
                    }
                  >
                    Cancel
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
      <div className="friends-pagination">
        <More
          page={requests}
          disabled={busy !== null}
          onClick={() =>
            void loadMore(requests, friendsApi.requests, setRequests)
          }
        />
      </div>
    </div>
  );
}
