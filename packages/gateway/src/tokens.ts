import { randomUUID } from "node:crypto";
import type { GatewayStateStore } from "./state-store.js";

interface DeviceAuthorization {
  authorizationId: string;
  hostDeviceId: string;
  clientDeviceId: string | undefined;
  clientName: string | undefined;
  createdAt: number;
  lastUsedAt: number;
}

interface TokenRecord {
  token: string;
  authorizations: Map<string, DeviceAuthorization>;
  createdAt: number;
  lastUsedAt: number;
}

export class AuthorizationManager {
  private tokens = new Map<string, TokenRecord>();
  private hostDeviceToTokens = new Map<string, Set<string>>();

  constructor(private readonly store?: GatewayStateStore) {}

  async hydrate(): Promise<void> {
    if (!this.store) return;
    try {
      const records = await this.store.loadAuthorizations();
      for (const record of records) {
        const token = this.register(record.token);
        this.authorize(token, record.hostDeviceId, {
          authorizationId: record.authorizationId,
          clientDeviceId: record.clientDeviceId,
          clientName: record.clientName,
          createdAt: record.createdAt,
          lastUsedAt: record.lastUsedAt,
          persist: false,
        });
      }
    } catch (err) {
      process.stderr.write(`[gateway] authorization store hydrate failed, using memory only: ${err}\n`);
    }
  }

  register(deviceToken?: string): string {
    if (deviceToken && this.tokens.has(deviceToken)) {
      const record = this.tokens.get(deviceToken)!;
      record.lastUsedAt = Date.now();
      return deviceToken;
    }
    const token = deviceToken || randomUUID();
    this.tokens.set(token, {
      token,
      authorizations: new Map(),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    return token;
  }

  authorize(
    token: string,
    hostDeviceId: string,
    input: {
      authorizationId?: string;
      clientDeviceId?: string;
      clientName?: string;
      createdAt?: number;
      lastUsedAt?: number;
      persist?: boolean;
    } = {},
  ): DeviceAuthorization | undefined {
    const record = this.tokens.get(token);
    if (!record) return undefined;
    const existing = record.authorizations.get(hostDeviceId);
    const now = Date.now();
    const authorization: DeviceAuthorization = {
      authorizationId: input.authorizationId ?? existing?.authorizationId ?? randomUUID(),
      hostDeviceId,
      clientDeviceId: input.clientDeviceId ?? existing?.clientDeviceId,
      clientName: input.clientName ?? existing?.clientName,
      createdAt: input.createdAt ?? existing?.createdAt ?? now,
      lastUsedAt: input.lastUsedAt ?? now,
    };
    record.authorizations.set(hostDeviceId, authorization);
    record.lastUsedAt = now;
    let tokens = this.hostDeviceToTokens.get(hostDeviceId);
    if (!tokens) {
      tokens = new Set();
      this.hostDeviceToTokens.set(hostDeviceId, tokens);
    }
    tokens.add(token);
    if (input.persist !== false) {
      this.persist(token, authorization);
    }
    return authorization;
  }

  validate(token: string): boolean {
    const record = this.tokens.get(token);
    if (!record) return false;
    record.lastUsedAt = Date.now();
    return true;
  }

  owns(token: string, hostDeviceId: string): boolean {
    const record = this.tokens.get(token);
    if (!record) return false;
    const authorization = record.authorizations.get(hostDeviceId);
    if (!authorization) return false;
    const now = Date.now();
    record.lastUsedAt = now;
    authorization.lastUsedAt = now;
    this.persist(token, authorization);
    return true;
  }

  revoke(token: string, hostDeviceId: string, authorizationId: string): boolean {
    const record = this.tokens.get(token);
    const authorization = record?.authorizations.get(hostDeviceId);
    if (!record || !authorization || authorization.authorizationId !== authorizationId) {
      return false;
    }
    record.authorizations.delete(hostDeviceId);
    const tokens = this.hostDeviceToTokens.get(hostDeviceId);
    tokens?.delete(token);
    if (tokens && tokens.size === 0) {
      this.hostDeviceToTokens.delete(hostDeviceId);
    }
    void this.store?.deleteAuthorization(authorizationId).catch((err) => {
      process.stderr.write(`[gateway] authorization store delete failed: ${err}\n`);
    });
    return true;
  }

  getHostDeviceIds(token: string): Set<string> {
    const record = this.tokens.get(token);
    if (!record) return new Set();
    record.lastUsedAt = Date.now();
    return new Set(record.authorizations.keys());
  }

  getSessionIds(token: string): Set<string> {
    return this.getHostDeviceIds(token);
  }

  getAuthorizationId(token: string, hostDeviceId: string): string | undefined {
    return this.tokens.get(token)?.authorizations.get(hostDeviceId)?.authorizationId;
  }

  getTokenForSession(hostDeviceId: string): string | undefined {
    return this.hostDeviceToTokens.get(hostDeviceId)?.values().next().value;
  }

  bind(token: string, hostDeviceId: string): boolean {
    return !!this.authorize(token, hostDeviceId);
  }

  private persist(token: string, authorization: DeviceAuthorization): void {
    void this.store?.saveAuthorization({
      token,
      authorizationId: authorization.authorizationId,
      hostDeviceId: authorization.hostDeviceId,
      clientDeviceId: authorization.clientDeviceId,
      clientName: authorization.clientName,
      createdAt: authorization.createdAt,
      lastUsedAt: authorization.lastUsedAt,
    }).catch((err) => {
      process.stderr.write(`[gateway] authorization store save failed: ${err}\n`);
    });
  }

  destroy(): void {}
}

export class TokenManager extends AuthorizationManager {}
