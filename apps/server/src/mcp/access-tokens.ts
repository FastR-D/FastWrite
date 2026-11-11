import { createHash, randomBytes } from "node:crypto";
import type { JsonDatabase } from "../storage/database";
import type { Principal } from "../auth/auth-service";
import type { AuthorizationService } from "../auth/authorization-service";
import { ApiError } from "../http";
export const MCP_SCOPES = ["read", "propose", "compile", "comment"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
export interface McpAccessToken {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  tokenHash: string;
  scopes: McpScope[];
  idpGroups?: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export class McpAccessTokens {
  constructor(
    private readonly db: JsonDatabase,
    private readonly authorization: AuthorizationService,
  ) {}
  async issue(
    projectId: string,
    principal: Principal,
    input: { name: string; scopes: McpScope[]; days?: number },
  ) {
    this.authorization.requireProject(principal, projectId, "project:manage");
    if (
      typeof input.name !== "string" ||
      !input.name.trim() ||
      !Array.isArray(input.scopes) ||
      input.scopes.some((scope) => !MCP_SCOPES.includes(scope)) ||
      !input.scopes.includes("read") ||
      !Number.isFinite(input.days ?? 30) ||
      (input.days ?? 30) < 1 ||
      (input.days ?? 30) > 90
    )
      throw new ApiError(
        400,
        "mcp_token_invalid",
        "请填写名称、读取权限及 1–90 天有效期",
      );
    const token = `fw_mcp_${randomBytes(32).toString("base64url")}`;
    const record: McpAccessToken = {
      id: crypto.randomUUID(),
      projectId,
      userId: principal.user.id,
      ...(principal.idpGroups ? { idpGroups: principal.idpGroups } : {}),
      name: input.name.trim().slice(0, 100),
      scopes: [...new Set(input.scopes)],
      tokenHash: hash(token),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(
        Date.now() + (input.days ?? 30) * 86400_000,
      ).toISOString(),
    };
    await this.db.mutate((state) => {
      state.mcpAccessTokens ??= [];
      if (
        state.mcpAccessTokens.filter(
          (item) =>
            item.projectId === projectId &&
            !item.revokedAt &&
            item.expiresAt > new Date().toISOString(),
        ).length >= 50
      )
        throw new ApiError(
          409,
          "mcp_token_limit",
          "请先撤销不再使用的项目令牌",
        );
      state.mcpAccessTokens.push(record);
    });
    return { token, access: publicToken(record) };
  }
  list(projectId: string, principal: Principal) {
    this.authorization.requireProject(principal, projectId, "project:manage");
    return (this.db.snapshot().mcpAccessTokens ?? [])
      .filter((item) => item.projectId === projectId)
      .map(publicToken);
  }
  async revoke(projectId: string, id: string, principal: Principal) {
    this.authorization.requireProject(principal, projectId, "project:manage");
    await this.db.mutate((state) => {
      const token = state.mcpAccessTokens?.find(
        (item) => item.projectId === projectId && item.id === id,
      );
      if (!token) throw new ApiError(404, "mcp_token_not_found", "令牌不存在");
      token.revokedAt = new Date().toISOString();
    });
  }
  authenticate(
    request: Request,
    projectId: string,
    scope: McpScope = "read",
  ): Principal {
    const token = /^Bearer (fw_mcp_[A-Za-z0-9_-]+)$/.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    const state = this.db.snapshot(),
      access =
        token &&
        state.mcpAccessTokens?.find(
          (item) =>
            item.tokenHash === hash(token) &&
            item.projectId === projectId &&
            !item.revokedAt &&
            item.expiresAt > new Date().toISOString(),
        );
    const user =
      access &&
      state.users.find(
        (item) => item.id === access.userId && item.status === "active",
      );
    if (!access || !user)
      throw new ApiError(
        401,
        "mcp_token_invalid",
        "需要有效的项目 MCP Bearer 令牌",
      );
    if (!access.scopes.includes(scope))
      throw new ApiError(403, "mcp_scope_denied", `令牌缺少 ${scope} 权限`);
    const principal = {
      user,
      sessionId: `mcp:${access.id}`,
      ...(access.idpGroups ? { idpGroups: access.idpGroups } : {}),
    };
    this.authorization.requireProject(principal, projectId, "project:read");
    return principal;
  }
}
function publicToken({ tokenHash, idpGroups, ...token }: McpAccessToken) {
  return token;
}
