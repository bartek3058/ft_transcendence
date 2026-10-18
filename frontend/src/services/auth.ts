export interface AuthUser {
  id: string;
  email: string;
  username: string;
  createdAt: string;
}

export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    fields?: Array<{ field?: string; code?: string }>;
  };
}

const mutationHeaders = {
  "Content-Type": "application/json",
  "X-CSRF-Protection": "1",
};

async function readError(response: Response): Promise<Error> {
  let body: ApiErrorBody | undefined;
  try {
    body = await response.json();
  } catch {
    /* empty/non-json error */
  }
  const message = body?.error?.message ?? `Błąd serwera (${response.status})`;
  const error = new Error(message) as Error & {
    status?: number;
    code?: string;
  };
  error.status = response.status;
  error.code = body?.error?.code;
  return error;
}

export async function register(
  email: string,
  username: string,
  password: string,
): Promise<AuthUser> {
  const response = await fetch("/api/auth/register", {
    method: "POST",
    credentials: "same-origin",
    headers: mutationHeaders,
    body: JSON.stringify({ email, username, password }),
  });
  if (!response.ok) throw await readError(response);
  return (await response.json()).user as AuthUser;
}

export async function login(
  email: string,
  password: string,
): Promise<AuthUser> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: mutationHeaders,
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw await readError(response);
  return (await response.json()).user as AuthUser;
}

export async function getMe(): Promise<AuthUser | null> {
  const response = await fetch("/api/auth/me", { credentials: "same-origin" });
  if (response.status === 401) return null;
  if (!response.ok) throw await readError(response);
  return (await response.json()).user as AuthUser;
}

export async function logout(): Promise<void> {
  const response = await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: mutationHeaders,
    body: "{}",
  });
  if (!response.ok) throw await readError(response);
}
