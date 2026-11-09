export type PublicUser = { id: string; username: string; rating: number };
export type Friend = {
  friendshipId: string;
  user: PublicUser & { online: boolean };
  acceptedAt: string;
};
export type FriendRequest = {
  id: string;
  direction: "incoming" | "outgoing";
  user: PublicUser;
  createdAt: string;
};
export type Page<T> = {
  items: T[];
  hasMore: boolean;
  offset: number;
  limit: number;
};
export class FriendsApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public retryAfter?: string | null,
  ) {
    super(message);
  }
}
async function request<T>(
  path: string,
  method = "GET",
  body?: object,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    credentials: "same-origin",
    ...(method === "GET"
      ? {}
      : {
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Protection": "1",
          },
          body: JSON.stringify(body ?? {}),
        }),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      error?: { message?: string; code?: string };
    } | null;
    throw new FriendsApiError(
      data?.error?.message ?? `Request failed (${response.status})`,
      response.status,
      data?.error?.code,
      response.headers.get("Retry-After"),
    );
  }
  return response.status === 204
    ? (undefined as T)
    : ((await response.json()) as T);
}
const page = (offset: number) => `limit=20&offset=${offset}`;
export const friendsApi = {
  friends: (offset = 0) => request<Page<Friend>>(`friends?${page(offset)}`),
  requests: (offset = 0) =>
    request<Page<FriendRequest>>(`friends/requests?${page(offset)}`),
  search: (q: string, offset = 0) =>
    request<Page<PublicUser>>(
      `users/search?q=${encodeURIComponent(q)}&${page(offset)}`,
    ),
  profile: (id: string) =>
    request<{ user: PublicUser }>(`users/${encodeURIComponent(id)}`),
  send: (targetUserId: string) =>
    request<{ request: { id: string } }>("friends/requests", "POST", {
      targetUserId,
    }),
  accept: (id: string) =>
    request<void>(
      `friends/requests/${encodeURIComponent(id)}/accept`,
      "POST",
      {},
    ),
  decline: (id: string) =>
    request<void>(`friends/requests/${encodeURIComponent(id)}`, "DELETE", {}),
  remove: (id: string) =>
    request<void>(`friends/${encodeURIComponent(id)}`, "DELETE", {}),
};
