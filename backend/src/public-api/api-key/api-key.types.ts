export interface GeneratedApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  rawKey: string; // ONLY returned once upon generation
  expiresAt: Date | null;
  createdAt: Date;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface ValidatedApiKeyResult {
  apiKeyId: string;
  user: {
    id: string;
    username: string;
    email: string;
    role: string;
  };
}
