import { createHash } from "node:crypto";
import { ApiError } from "../http";

export interface ApiKeyConfig {
  key: string;
  name: string;
  scopes: string[];
  createdAt: string;
  userId?: string; // 关联的 FastWrite 用户 ID
  email?: string;  // 用户邮箱（可选，用于显示）
  expiresAt?: string; // 过期时间（可选）
}

/**
 * API Key 服务 - 用于验证来自 FastResearch 等外部服务的请求
 * 支持将 API Key 绑定到具体的 FastWrite 用户账户
 */
export class ApiKeyService {
  private readonly keys: Map<string, ApiKeyConfig>;

  constructor(rawKeys?: string) {
    this.keys = new Map();
    this.loadKeys(rawKeys);
  }

  private loadKeys(rawKeys?: string): void {
    if (!rawKeys) return;

    try {
      const configs = JSON.parse(rawKeys) as ApiKeyConfig[];
      for (const config of configs) {
        if (!config.key || !config.name) continue;

        // 检查是否过期
        if (config.expiresAt && new Date(config.expiresAt) < new Date()) {
          console.warn(`API Key for ${config.name} has expired`);
          continue;
        }

        const keyHash = this.hashKey(config.key);
        this.keys.set(keyHash, {
          ...config,
          key: keyHash, // 存储哈希值而不是原始密钥
        });
      }
    } catch (error) {
      console.error("Failed to load API keys:", error);
    }
  }

  private hashKey(key: string): string {
    return createHash("sha256").update(key.trim()).digest("hex");
  }

  /**
   * 验证 API Key 并返回配置
   */
  verify(key: string): ApiKeyConfig | null {
    if (!key || typeof key !== "string") return null;

    const keyHash = this.hashKey(key);
    const config = this.keys.get(keyHash);

    if (!config) return null;

    return config;
  }

  /**
   * 检查 API Key 是否有指定的权限范围
   */
  hasScope(config: ApiKeyConfig, requiredScope: string): boolean {
    return config.scopes.includes("*") || config.scopes.includes(requiredScope);
  }

  /**
   * 从请求头中提取 API Key
   */
  extractFromRequest(request: Request): string | null {
    // 支持两种格式：
    // 1. Authorization: Bearer <api-key>
    // 2. X-API-Key: <api-key>
    const authHeader = request.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      return authHeader.slice(7).trim();
    }

    const apiKeyHeader = request.headers.get("x-api-key");
    if (apiKeyHeader) {
      return apiKeyHeader.trim();
    }

    return null;
  }

  /**
   * 验证请求并要求特定权限范围
   */
  requireScope(request: Request, requiredScope: string): ApiKeyConfig {
    const key = this.extractFromRequest(request);
    if (!key) {
      throw new ApiError(401, "api_key_missing", "API Key is required");
    }

    const config = this.verify(key);
    if (!config) {
      throw new ApiError(401, "api_key_invalid", "Invalid API Key");
    }

    if (!this.hasScope(config, requiredScope)) {
      throw new ApiError(403, "api_key_insufficient_scope", `API Key does not have required scope: ${requiredScope}`);
    }

    return config;
  }
}
