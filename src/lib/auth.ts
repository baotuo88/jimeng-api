import _ from "lodash";

import APIException from "@/lib/exceptions/APIException.ts";
import Request from "@/lib/request/Request.ts";
import runtimeStore from "@/lib/runtime-store.ts";
import EX from "@/api/consts/exceptions.ts";
import { tokenSplit } from "@/api/controllers/core.ts";
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from "@/api/consts/common.ts";

const PUBLIC_PATH_PREFIXES = ["/", "/ping", "/page", "/admin/bootstrap"];
const ADMIN_PATH_PREFIXES = ["/admin"];
const ADMIN_COOKIE_NAME = "jimeng_admin_key";

function normalizeBearerToken(value?: string) {
  if (!_.isString(value)) return "";
  return value.replace(/^Bearer\s+/i, "").trim();
}

function getHeaderValue(headers: any, name: string) {
  return headers[name] || headers[name.toLowerCase()] || "";
}

function getCookieValue(headers: any, name: string) {
  const cookieHeader = getHeaderValue(headers, "cookie");
  if (!cookieHeader) return "";
  const matched = cookieHeader
    .split(";")
    .map(item => item.trim())
    .find(item => item.startsWith(`${name}=`));
  if (!matched) return "";
  return decodeURIComponent(matched.slice(name.length + 1));
}

export function getAdminCookieName() {
  return ADMIN_COOKIE_NAME;
}

export function buildAdminCookieValue(value: string) {
  return `${ADMIN_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
}

export function getAdminAccessValue(request: Request) {
  return (
    getHeaderValue(request.headers, "x-admin-key") ||
    (_.isString(request.query?.admin_key) ? request.query.admin_key.trim() : "") ||
    getCookieValue(request.headers, ADMIN_COOKIE_NAME)
  );
}

export function hasAdminAccess(request: Request, configuredAdminKey: string) {
  if (!configuredAdminKey) return true;
  const candidates = [
    getHeaderValue(request.headers, "x-admin-key"),
    _.isString(request.query?.admin_key) ? request.query.admin_key.trim() : "",
    getCookieValue(request.headers, ADMIN_COOKIE_NAME),
  ].filter(Boolean);
  return candidates.some(candidate => candidate === configuredAdminKey);
}

function getRequestedModel(request: Request): string | null {
  if (_.isString(request.body?.model) && request.body.model.trim()) {
    return request.body.model.trim();
  }
  if (request.path.startsWith("/v1/images")) return DEFAULT_IMAGE_MODEL;
  if (request.path.startsWith("/v1/videos")) return DEFAULT_VIDEO_MODEL;
  return null;
}

export function isPublicPath(path: string) {
  if (path === "/") return true;
  return PUBLIC_PATH_PREFIXES.some(prefix => prefix !== "/" && path.startsWith(prefix));
}

export function isAdminPath(path: string) {
  return ADMIN_PATH_PREFIXES.some(prefix => path.startsWith(prefix));
}

export function ensureAdminAuth(request: Request) {
  const configuredAdminKey = runtimeStore.getAdminApiKey();
  if (!configuredAdminKey) return;

  if (hasAdminAccess(request, configuredAdminKey)) return;

  throw new APIException(EX.API_REQUEST_FAILED, "管理接口需要有效的 x-admin-key").setHTTPStatusCode(401);
}

export function ensureApiAccess(request: Request) {
  if (isPublicPath(request.path)) return;
  if (isAdminPath(request.path)) return;
  if (!runtimeStore.isApiKeyRequired()) return;

  const directApiKey = getHeaderValue(request.headers, "x-api-key");
  const bearerCandidate = normalizeBearerToken(getHeaderValue(request.headers, "authorization"));
  const rawApiKey = directApiKey || bearerCandidate;
  if (!rawApiKey) {
    throw new APIException(EX.API_REQUEST_FAILED, "缺少 API Key，请通过 x-api-key 访问").setHTTPStatusCode(401);
  }

  const matchedApiKey = runtimeStore.findApiKey(rawApiKey);
  if (!matchedApiKey) {
    throw new APIException(EX.API_REQUEST_FAILED, "API Key 无效").setHTTPStatusCode(403);
  }

  const apiKeyState = runtimeStore.getApiKeyState(matchedApiKey.id);
  if (!apiKeyState.ok) {
    throw new APIException(EX.API_REQUEST_FAILED, apiKeyState.reason).setHTTPStatusCode(403);
  }

  const pathAllowedResult = runtimeStore.isPathAllowedForApiKey(matchedApiKey.id, request.path);
  if (!pathAllowedResult.ok) {
    throw new APIException(EX.API_REQUEST_FAILED, pathAllowedResult.reason).setHTTPStatusCode(403);
  }

  const modelAllowedResult = runtimeStore.isModelAllowedForApiKey(matchedApiKey.id, getRequestedModel(request));
  if (!modelAllowedResult.ok) {
    throw new APIException(EX.API_REQUEST_FAILED, modelAllowedResult.reason).setHTTPStatusCode(403);
  }

  const consumeResult = runtimeStore.checkAndConsumeApiKey(matchedApiKey.id);
  if (!consumeResult.ok) {
    throw new APIException(EX.API_REQUEST_FAILED, consumeResult.reason).setHTTPStatusCode(429);
  }

  request.state.apiKey = {
    id: matchedApiKey.id,
    name: matchedApiKey.name,
  };
}

export function resolveRequestTokens(request: Request) {
  const explicitTokens = resolveExplicitRequestTokenList(request);
  if (explicitTokens.length > 0) {
    request.state.tokenSource = "request";
    return {
      source: "request" as const,
      tokens: explicitTokens,
    };
  }

  const managedAccount = runtimeStore.selectAccount();
  if (!managedAccount) {
    const nextAvailableAt = runtimeStore.getNextAvailableAccountTime();
    throw new APIException(
      EX.API_REQUEST_FAILED,
      nextAvailableAt
        ? `未提供 Authorization token，且账号池当前都在冷却中，最早恢复时间: ${nextAvailableAt}`
        : "未提供 Authorization token，且管理后台没有可用账号"
    ).setHTTPStatusCode(400);
  }

  request.state.selectedAccount = {
    id: managedAccount.id,
    name: managedAccount.name,
    source: "managed",
  };
  request.state.tokenSource = "managed";
  return {
    source: "managed" as const,
    tokens: [managedAccount.token],
  };
}

export function resolveExplicitRequestTokenList(request: Request) {
  const sessionTokenHeader = getHeaderValue(request.headers, "x-session-token") || getHeaderValue(request.headers, "x-session-tokens");
  if (sessionTokenHeader) {
    return sessionTokenHeader.split(",").map(token => token.trim()).filter(Boolean);
  }

  const authorization = getHeaderValue(request.headers, "authorization");
  const bearerValue = normalizeBearerToken(authorization);
  const requestHasApiKeyInAuthorization = bearerValue && runtimeStore.isKnownApiKey(bearerValue);

  if (authorization && !requestHasApiKeyInAuthorization) {
    return tokenSplit(authorization).map(token => token.trim()).filter(Boolean);
  }

  return [];
}

export function resolveManagedTokenList() {
  const accounts = runtimeStore.listEnabledAccounts();
  if (accounts.length === 0) {
    throw new APIException(
      EX.API_REQUEST_FAILED,
      "管理后台没有可用账号"
    ).setHTTPStatusCode(400);
  }
  return accounts.map(account => account.token);
}

function shouldRetryWithAnotherToken(error: any) {
  if (!error) return false;
  const errorCode = error?.errcode;
  const errorMessage = String(error?.message || "").toLowerCase();

  if (errorCode === EX.API_REQUEST_PARAMS_INVALID[0]) return false;
  if (errorCode === EX.API_CONTENT_FILTERED[0]) return false;

  if ([
    EX.API_TOKEN_EXPIRES[0],
    EX.API_REQUEST_FAILED[0],
    EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS[0],
  ].includes(errorCode)) return true;

  return [
    "timeout",
    "network",
    "proxy",
    "token",
    "登录失效",
    "积分不足",
    "socket hang up",
    "econn",
    "enotfound",
  ].some(keyword => errorMessage.includes(keyword));
}

export async function executeWithTokenRetry<T>(
  request: Request,
  operation: (token: string) => Promise<T>
): Promise<T> {
  const explicitTokens = resolveExplicitRequestTokenList(request);
  if (explicitTokens.length > 0) {
    request.state.tokenSource = "request";
    let lastError: any = null;
    for (let index = 0; index < explicitTokens.length; index++) {
      const token = explicitTokens[index];
      try {
        return await operation(token);
      } catch (error) {
        lastError = error;
        if (!shouldRetryWithAnotherToken(error) || index === explicitTokens.length - 1) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  const enabledAccounts = runtimeStore.listEnabledAccounts();
  if (enabledAccounts.length === 0) {
    const nextAvailableAt = runtimeStore.getNextAvailableAccountTime();
    throw new APIException(
      EX.API_REQUEST_FAILED,
      nextAvailableAt
        ? `账号池当前都在冷却中，最早恢复时间: ${nextAvailableAt}`
        : "管理后台没有可用账号"
    ).setHTTPStatusCode(400);
  }

  const excludedAccountIds: string[] = [];
  let lastError: any = null;

  while (excludedAccountIds.length < enabledAccounts.length) {
    const managedAccount = runtimeStore.selectAccount(excludedAccountIds);
    if (!managedAccount) break;

    request.state.selectedAccount = {
      id: managedAccount.id,
      name: managedAccount.name,
      source: "managed",
    };
    request.state.tokenSource = "managed";
    request.state.accountStateManaged = true;

    try {
      const result = await operation(managedAccount.token);
      runtimeStore.markAccountSuccess(managedAccount.id);
      return result;
    } catch (error) {
      lastError = error;
      runtimeStore.markAccountFailure(managedAccount.id, error?.message || "unknown error");
      excludedAccountIds.push(managedAccount.id);

      if (!shouldRetryWithAnotherToken(error)) {
        throw error;
      }
    }
  }

  if (lastError) throw lastError;

  const nextAvailableAt = runtimeStore.getNextAvailableAccountTime();
  throw new APIException(
    EX.API_REQUEST_FAILED,
    nextAvailableAt
      ? `账号池当前都在冷却中，最早恢复时间: ${nextAvailableAt}`
      : "管理后台没有可用账号"
  ).setHTTPStatusCode(400);
}
