import path from "path";

import fs from "fs-extra";
import _ from "lodash";

import config from "@/lib/config.ts";
import environment from "@/lib/environment.ts";
import util from "@/lib/util.ts";
import { parseProxyFromToken, parseRegionFromToken } from "@/api/controllers/core.ts";

export interface ManagedAccount {
  id: string;
  name: string;
  token: string;
  enabled: boolean;
  weight?: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  lastFailureReason?: string | null;
  cooldownUntil?: string | null;
  successCount?: number;
  failureCount?: number;
  consecutiveFailures?: number;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  key: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
  totalRequests?: number;
  successRequests?: number;
  failedRequests?: number;
  totalQuota?: number | null;
  requestsPerMinute?: number | null;
  currentMinuteWindow?: string | null;
  currentMinuteCount?: number;
  lastFailureAt?: string | null;
  lastFailureReason?: string | null;
  allowedPathPrefixes?: string[];
  allowedModels?: string[];
  expiresAt?: string | null;
  revokedAt?: string | null;
  revokeReason?: string | null;
  revokeHistory?: ApiKeyRevokeRecord[];
}

export interface ApiKeyRevokeRecord {
  time: string;
  action: "revoked" | "restored";
  reason?: string | null;
}

export interface RuntimeSettings {
  requireApiKey: boolean;
  adminApiKey: string;
  rotationStrategy: "round_robin";
}

export interface RuntimeStoreData {
  settings: RuntimeSettings;
  accounts: ManagedAccount[];
  apiKeys: ApiKeyRecord[];
  requestLogs: RuntimeRequestLog[];
}

export interface SelectedAccount {
  id: string;
  name: string;
  token: string;
}

export interface RuntimeOverview {
  settings: RuntimeSettings;
  accounts: Array<ManagedAccount & { maskedToken: string; region: string; proxyEnabled: boolean; coolingDown: boolean }>;
  apiKeys: Array<Omit<ApiKeyRecord, "key"> & {
    maskedKey: string;
    quotaRemaining: number | null;
    minuteRemaining: number | null;
    recent24hRequests: number;
    recent24hSuccess: number;
    recent24hFailures: number;
    expired: boolean;
    revoked: boolean;
  }>;
  requestLogs: RuntimeRequestLog[];
  stats: {
    accountCount: number;
    enabledAccountCount: number;
    coolingAccountCount: number;
    apiKeyCount: number;
    enabledApiKeyCount: number;
    recentLogCount: number;
  };
}

export interface RuntimeStatsSummary {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageDurationMs: number;
  windowHours: number;
  groupedByPath: Array<{ path: string; total: number; success: number; failed: number }>;
  recentLogs: RuntimeRequestLog[];
}

export interface RuntimeRequestLog {
  id: string;
  time: string;
  method: string;
  path: string;
  statusCode: number;
  ok: boolean;
  durationMs: number;
  source: "managed" | "request" | "system";
  accountId?: string | null;
  accountName?: string | null;
  apiKeyId?: string | null;
  apiKeyName?: string | null;
  errorMessage?: string | null;
}

const DATA_DIR = path.resolve(config.system.dataDir || "./data");
const STORE_PATH = path.join(DATA_DIR, `runtime-${environment.env}.json`);
const REQUEST_LOG_LIMIT = 500;
const ACCOUNT_FAILURE_THRESHOLD = 2;
const ACCOUNT_COOLDOWN_MINUTES = 10;
const MAX_ACCOUNT_WEIGHT = 10;

function nowIso() {
  return new Date().toISOString();
}

function currentMinuteWindow() {
  return new Date().toISOString().slice(0, 16);
}

function recent24hCutoff() {
  return Date.now() - 24 * 60 * 60 * 1000;
}

function normalizeAccountWeight(value: any) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(1, Math.min(MAX_ACCOUNT_WEIGHT, Math.floor(numeric)));
}

function isExpired(value?: string | null) {
  if (!value) return false;
  return new Date(value).getTime() <= Date.now();
}

function maskValue(value: string, start = 6, end = 4) {
  if (!value) return "";
  if (value.length <= start + end) return `${value.slice(0, 2)}***${value.slice(-2)}`;
  return `${value.slice(0, start)}***${value.slice(-end)}`;
}

function getRegionLabel(token: string) {
  const region = parseRegionFromToken(token);
  if (region.isUS) return "US";
  if (region.isHK) return "HK";
  if (region.isJP) return "JP";
  if (region.isSG) return "SG";
  return "CN";
}

class RuntimeStore {
  private data: RuntimeStoreData | null = null;
  private rotationCursor = 0;

  private getDefaultData(): RuntimeStoreData {
    return {
      settings: {
        requireApiKey: false,
        adminApiKey: config.system.adminApiKey || "",
        rotationStrategy: "round_robin",
      },
      accounts: [],
      apiKeys: [],
      requestLogs: [],
    };
  }

  private ensureLoaded() {
    if (this.data) return;
    fs.ensureDirSync(DATA_DIR);
    if (!fs.existsSync(STORE_PATH)) {
      this.data = this.getDefaultData();
      this.save();
      return;
    }
    const loaded = util.ignoreJSONParse(fs.readFileSync(STORE_PATH, "utf8")) || {};
    const defaults = this.getDefaultData();
    this.data = {
      settings: {
        ...defaults.settings,
        ...(loaded.settings || {}),
      },
      accounts: Array.isArray(loaded.accounts) ? loaded.accounts : [],
      apiKeys: Array.isArray(loaded.apiKeys) ? loaded.apiKeys : [],
      requestLogs: Array.isArray(loaded.requestLogs) ? loaded.requestLogs : [],
    };
  }

  private save() {
    if (!this.data) return;
    fs.ensureDirSync(DATA_DIR);
    fs.writeFileSync(STORE_PATH, JSON.stringify(this.data, null, 2));
  }

  getAdminBootstrap() {
    this.ensureLoaded();
    return {
      adminKeyRequired: !!this.data!.settings.adminApiKey,
      requireApiKey: this.data!.settings.requireApiKey,
      hasAccounts: this.data!.accounts.some(account => account.enabled),
      hasApiKeys: this.data!.apiKeys.some(apiKey => apiKey.enabled),
    };
  }

  getOverview(): RuntimeOverview {
    this.ensureLoaded();
    const accounts = this.data!.accounts.map(account => {
      const { proxyUrl } = parseProxyFromToken(account.token);
      const coolingDown = !!account.cooldownUntil && new Date(account.cooldownUntil).getTime() > Date.now();
      return {
        ...account,
        weight: normalizeAccountWeight(account.weight),
        maskedToken: maskValue(account.token, 8, 6),
        region: getRegionLabel(account.token),
        proxyEnabled: !!proxyUrl,
        coolingDown,
      };
    });
    const apiKeys = this.data!.apiKeys.map(apiKey => {
      const recentLogs = this.data!.requestLogs.filter(log =>
        log.apiKeyId === apiKey.id && new Date(log.time).getTime() >= recent24hCutoff()
      );
      const { key, ...rest } = apiKey;
      return {
        ...rest,
        maskedKey: maskValue(key, 8, 4),
        quotaRemaining: _.isFinite(rest.totalQuota) ? Math.max(0, Number(rest.totalQuota) - Number(rest.totalRequests || 0)) : null,
        minuteRemaining: _.isFinite(rest.requestsPerMinute)
          ? Math.max(
              0,
              Number(rest.requestsPerMinute) -
                ((rest.currentMinuteWindow === currentMinuteWindow() ? Number(rest.currentMinuteCount || 0) : 0))
            )
          : null,
        recent24hRequests: recentLogs.length,
        recent24hSuccess: recentLogs.filter(log => log.ok).length,
        recent24hFailures: recentLogs.filter(log => !log.ok).length,
        expired: isExpired(rest.expiresAt),
        revoked: !!rest.revokedAt,
      };
    });

    return {
      settings: _.cloneDeep(this.data!.settings),
      accounts,
      apiKeys,
      requestLogs: _.cloneDeep(this.data!.requestLogs.slice(0, 40)),
      stats: {
        accountCount: accounts.length,
        enabledAccountCount: accounts.filter(account => account.enabled).length,
        coolingAccountCount: accounts.filter(account => account.coolingDown).length,
        apiKeyCount: apiKeys.length,
        enabledApiKeyCount: apiKeys.filter(apiKey => apiKey.enabled).length,
        recentLogCount: this.data!.requestLogs.length,
      },
    };
  }

  updateSettings(input: Partial<RuntimeSettings>) {
    this.ensureLoaded();
    this.data!.settings = {
      ...this.data!.settings,
      ..._.pickBy(input, value => !_.isUndefined(value)),
      adminApiKey: _.defaultTo(input.adminApiKey, this.data!.settings.adminApiKey || ""),
      rotationStrategy: "round_robin",
    };
    this.save();
    return _.cloneDeep(this.data!.settings);
  }

  listEnabledAccounts() {
    this.ensureLoaded();
    return this.data!.accounts
      .filter(account => account.enabled)
      .map(account => ({
        ...account,
        weight: normalizeAccountWeight(account.weight),
      }));
  }

  getAccountById(id: string) {
    this.ensureLoaded();
    return this.data!.accounts.find(account => account.id === id) || null;
  }

  upsertAccount(input: Partial<ManagedAccount> & { name: string; token?: string }) {
    this.ensureLoaded();
    const existing = input.id
      ? this.data!.accounts.find(account => account.id === input.id)
      : null;
    const timestamp = nowIso();

    if (existing) {
      existing.name = input.name;
      existing.enabled = _.defaultTo(input.enabled, existing.enabled);
      existing.weight = _.isUndefined(input.weight) ? normalizeAccountWeight(existing.weight) : normalizeAccountWeight(input.weight);
      existing.notes = _.defaultTo(input.notes, existing.notes || "");
      existing.updatedAt = timestamp;
      if (_.isString(input.token) && input.token.trim()) {
        existing.token = input.token.trim();
      }
      this.save();
      return _.cloneDeep(existing);
    }

    if (!input.token || !input.token.trim()) {
      throw new Error("新增账号时 token 不能为空");
    }

    const created: ManagedAccount = {
      id: util.uuid(false),
      name: input.name.trim(),
      token: input.token.trim(),
      enabled: _.defaultTo(input.enabled, true),
      weight: normalizeAccountWeight(input.weight),
      notes: _.defaultTo(input.notes, ""),
      createdAt: timestamp,
      updatedAt: timestamp,
      lastUsedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      cooldownUntil: null,
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
    };
    this.data!.accounts.unshift(created);
    this.save();
    return _.cloneDeep(created);
  }

  deleteAccount(id: string) {
    this.ensureLoaded();
    const before = this.data!.accounts.length;
    this.data!.accounts = this.data!.accounts.filter(account => account.id !== id);
    if (this.rotationCursor >= this.data!.accounts.length) this.rotationCursor = 0;
    if (this.data!.accounts.length !== before) this.save();
  }

  selectAccount(excludedAccountIds: string[] = []): SelectedAccount | null {
    this.ensureLoaded();
    const candidates = this.data!.accounts.filter(
      account => account.enabled
        && !excludedAccountIds.includes(account.id)
        && !this.isAccountCoolingDown(account)
    );
    if (candidates.length === 0) return null;

    const weightedCandidates = candidates.flatMap(account =>
      Array.from({ length: normalizeAccountWeight(account.weight) }, () => account)
    );
    const currentIndex = this.rotationCursor % weightedCandidates.length;
    const selected = weightedCandidates[currentIndex];
    this.rotationCursor = (currentIndex + 1) % weightedCandidates.length;
    selected.lastUsedAt = nowIso();
    selected.updatedAt = nowIso();
    this.save();

    return {
      id: selected.id,
      name: selected.name,
      token: selected.token,
    };
  }

  touchAccount(id: string) {
    this.ensureLoaded();
    const account = this.data!.accounts.find(item => item.id === id);
    if (!account) return;
    account.lastUsedAt = nowIso();
    account.updatedAt = nowIso();
    this.save();
  }

  private isAccountCoolingDown(account: ManagedAccount) {
    if (!account.cooldownUntil) return false;
    return new Date(account.cooldownUntil).getTime() > Date.now();
  }

  markAccountSuccess(id: string) {
    this.ensureLoaded();
    const account = this.data!.accounts.find(item => item.id === id);
    if (!account) return;
    account.lastUsedAt = nowIso();
    account.lastSuccessAt = nowIso();
    account.updatedAt = nowIso();
    account.successCount = (account.successCount || 0) + 1;
    account.consecutiveFailures = 0;
    account.cooldownUntil = null;
    this.save();
  }

  markAccountFailure(id: string, reason: string) {
    this.ensureLoaded();
    const account = this.data!.accounts.find(item => item.id === id);
    if (!account) return;

    account.lastFailureAt = nowIso();
    account.lastFailureReason = reason;
    account.updatedAt = nowIso();
    account.failureCount = (account.failureCount || 0) + 1;
    account.consecutiveFailures = (account.consecutiveFailures || 0) + 1;

    if ((account.consecutiveFailures || 0) >= ACCOUNT_FAILURE_THRESHOLD) {
      const cooldownUntil = new Date(Date.now() + ACCOUNT_COOLDOWN_MINUTES * 60 * 1000).toISOString();
      account.cooldownUntil = cooldownUntil;
      account.consecutiveFailures = 0;
    }

    this.save();
  }

  resetAccountHealth(id: string) {
    this.ensureLoaded();
    const account = this.data!.accounts.find(item => item.id === id);
    if (!account) return null;
    account.cooldownUntil = null;
    account.consecutiveFailures = 0;
    account.lastFailureAt = null;
    account.lastFailureReason = null;
    account.updatedAt = nowIso();
    this.save();
    return _.cloneDeep(account);
  }

  getNextAvailableAccountTime() {
    this.ensureLoaded();
    const coolingAccounts = this.data!.accounts
      .filter(account => account.enabled && this.isAccountCoolingDown(account) && account.cooldownUntil)
      .map(account => account.cooldownUntil as string)
      .sort();
    return coolingAccounts[0] || null;
  }

  appendRequestLog(entry: Omit<RuntimeRequestLog, "id" | "time">) {
    this.ensureLoaded();
    const log: RuntimeRequestLog = {
      id: util.uuid(false),
      time: nowIso(),
      ...entry,
    };
    this.data!.requestLogs.unshift(log);
    if (this.data!.requestLogs.length > REQUEST_LOG_LIMIT) {
      this.data!.requestLogs = this.data!.requestLogs.slice(0, REQUEST_LOG_LIMIT);
    }
    this.save();
    return log;
  }

  getRequestStats({
    accountId,
    apiKeyId,
    windowHours = 24,
  }: {
    accountId?: string | null;
    apiKeyId?: string | null;
    windowHours?: number;
  } = {}): RuntimeStatsSummary {
    this.ensureLoaded();
    const cutoff = Date.now() - Math.max(1, windowHours) * 60 * 60 * 1000;
    const logs = this.data!.requestLogs.filter(log => {
      const inWindow = new Date(log.time).getTime() >= cutoff;
      const accountMatched = !accountId || log.accountId === accountId;
      const apiKeyMatched = !apiKeyId || log.apiKeyId === apiKeyId;
      return inWindow && accountMatched && apiKeyMatched;
    });

    const totalRequests = logs.length;
    const successfulRequests = logs.filter(log => log.ok).length;
    const failedRequests = totalRequests - successfulRequests;
    const averageDurationMs = totalRequests > 0
      ? Math.round(logs.reduce((sum, log) => sum + Number(log.durationMs || 0), 0) / totalRequests)
      : 0;

    const groupedByPathMap = new Map<string, { path: string; total: number; success: number; failed: number }>();
    logs.forEach(log => {
      const current = groupedByPathMap.get(log.path) || {
        path: log.path,
        total: 0,
        success: 0,
        failed: 0,
      };
      current.total += 1;
      if (log.ok) current.success += 1;
      else current.failed += 1;
      groupedByPathMap.set(log.path, current);
    });

    return {
      totalRequests,
      successfulRequests,
      failedRequests,
      averageDurationMs,
      windowHours,
      groupedByPath: Array.from(groupedByPathMap.values()).sort((a, b) => b.total - a.total).slice(0, 10),
      recentLogs: _.cloneDeep(logs.slice(0, 30)),
    };
  }

  upsertApiKey(input: Partial<ApiKeyRecord> & { name: string; key?: string }) {
    this.ensureLoaded();
    const existing = input.id
      ? this.data!.apiKeys.find(apiKey => apiKey.id === input.id)
      : null;
    const timestamp = nowIso();

    if (existing) {
      existing.name = input.name.trim();
      existing.enabled = _.defaultTo(input.enabled, existing.enabled);
      existing.updatedAt = timestamp;
      existing.totalQuota = _.isNull(input.totalQuota) || _.isFinite(input.totalQuota) ? _.defaultTo(input.totalQuota, null) : existing.totalQuota;
      existing.requestsPerMinute = _.isNull(input.requestsPerMinute) || _.isFinite(input.requestsPerMinute) ? _.defaultTo(input.requestsPerMinute, null) : existing.requestsPerMinute;
      existing.allowedPathPrefixes = Array.isArray(input.allowedPathPrefixes) ? input.allowedPathPrefixes : existing.allowedPathPrefixes;
      existing.allowedModels = Array.isArray(input.allowedModels) ? input.allowedModels : existing.allowedModels;
      existing.expiresAt = _.isUndefined(input.expiresAt) ? existing.expiresAt : _.defaultTo(input.expiresAt, null);
      if (_.isString(input.key) && input.key.trim()) {
        existing.key = input.key.trim();
      }
      this.save();
      return _.cloneDeep(existing);
    }

    const created: ApiKeyRecord = {
      id: util.uuid(false),
      name: input.name.trim(),
      key: (input.key && input.key.trim()) || `jm_${util.generateRandomString({ length: 32, charset: "alphabetic" }).toLowerCase()}`,
      enabled: _.defaultTo(input.enabled, true),
      createdAt: timestamp,
      updatedAt: timestamp,
      lastUsedAt: null,
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      totalQuota: _.isFinite(input.totalQuota) ? Number(input.totalQuota) : null,
      requestsPerMinute: _.isFinite(input.requestsPerMinute) ? Number(input.requestsPerMinute) : null,
      currentMinuteWindow: null,
      currentMinuteCount: 0,
      lastFailureAt: null,
      lastFailureReason: null,
      allowedPathPrefixes: Array.isArray(input.allowedPathPrefixes) ? input.allowedPathPrefixes : [],
      allowedModels: Array.isArray(input.allowedModels) ? input.allowedModels : [],
      expiresAt: _.defaultTo(input.expiresAt, null),
      revokedAt: null,
      revokeReason: null,
      revokeHistory: [],
    };
    this.data!.apiKeys.unshift(created);
    this.save();
    return _.cloneDeep(created);
  }

  deleteApiKey(id: string) {
    this.ensureLoaded();
    const before = this.data!.apiKeys.length;
    this.data!.apiKeys = this.data!.apiKeys.filter(apiKey => apiKey.id !== id);
    if (before !== this.data!.apiKeys.length) this.save();
  }

  findApiKey(rawKey: string) {
    this.ensureLoaded();
    return this.data!.apiKeys.find(apiKey => apiKey.key === rawKey) || null;
  }

  touchApiKey(id: string) {
    this.ensureLoaded();
    const apiKey = this.data!.apiKeys.find(item => item.id === id);
    if (!apiKey) return;
    apiKey.lastUsedAt = nowIso();
    apiKey.updatedAt = nowIso();
    this.save();
  }

  getApiKeyById(id: string) {
    this.ensureLoaded();
    return this.data!.apiKeys.find(apiKey => apiKey.id === id) || null;
  }

  revokeApiKey(id: string, reason?: string | null) {
    this.ensureLoaded();
    const apiKey = this.data!.apiKeys.find(item => item.id === id);
    if (!apiKey) return null;
    apiKey.revokedAt = nowIso();
    apiKey.revokeReason = reason || "manual revoke";
    apiKey.updatedAt = nowIso();
    apiKey.revokeHistory = Array.isArray(apiKey.revokeHistory) ? apiKey.revokeHistory : [];
    apiKey.revokeHistory.unshift({
      time: apiKey.revokedAt,
      action: "revoked",
      reason: apiKey.revokeReason,
    });
    this.save();
    return _.cloneDeep(apiKey);
  }

  restoreApiKey(id: string, reason?: string | null) {
    this.ensureLoaded();
    const apiKey = this.data!.apiKeys.find(item => item.id === id);
    if (!apiKey) return null;
    apiKey.revokedAt = null;
    apiKey.revokeReason = null;
    apiKey.updatedAt = nowIso();
    apiKey.revokeHistory = Array.isArray(apiKey.revokeHistory) ? apiKey.revokeHistory : [];
    apiKey.revokeHistory.unshift({
      time: nowIso(),
      action: "restored",
      reason: reason || "manual restore",
    });
    this.save();
    return _.cloneDeep(apiKey);
  }

  getApiKeyState(id: string) {
    this.ensureLoaded();
    const apiKey = this.data!.apiKeys.find(item => item.id === id);
    if (!apiKey) return { ok: false as const, reason: "API Key 无效" };
    if (!apiKey.enabled) return { ok: false as const, reason: "API Key 已停用" };
    if (apiKey.revokedAt) return { ok: false as const, reason: `API Key 已吊销: ${apiKey.revokeReason || "manual revoke"}` };
    if (isExpired(apiKey.expiresAt)) return { ok: false as const, reason: `API Key 已过期: ${apiKey.expiresAt}` };
    return { ok: true as const };
  }

  checkAndConsumeApiKey(id: string) {
    this.ensureLoaded();
    const apiKey = this.data!.apiKeys.find(item => item.id === id);
    if (!apiKey) return { ok: false as const, reason: "API Key 无效" };
    if (!apiKey.enabled) return { ok: false as const, reason: "API Key 已停用" };
    if (apiKey.revokedAt) return { ok: false as const, reason: `API Key 已吊销: ${apiKey.revokeReason || "manual revoke"}` };
    if (isExpired(apiKey.expiresAt)) return { ok: false as const, reason: `API Key 已过期: ${apiKey.expiresAt}` };

    if (_.isFinite(apiKey.totalQuota) && Number(apiKey.totalRequests || 0) >= Number(apiKey.totalQuota)) {
      return { ok: false as const, reason: "API Key 总配额已用尽" };
    }

    const minuteWindow = currentMinuteWindow();
    if (apiKey.currentMinuteWindow !== minuteWindow) {
      apiKey.currentMinuteWindow = minuteWindow;
      apiKey.currentMinuteCount = 0;
    }

    if (_.isFinite(apiKey.requestsPerMinute) && Number(apiKey.currentMinuteCount || 0) >= Number(apiKey.requestsPerMinute)) {
      return { ok: false as const, reason: "API Key 已触发分钟级限流" };
    }

    apiKey.currentMinuteCount = Number(apiKey.currentMinuteCount || 0) + 1;
    apiKey.lastUsedAt = nowIso();
    apiKey.updatedAt = nowIso();
    this.save();
    return { ok: true as const };
  }

  markApiKeyResult(id: string, ok: boolean, failureReason?: string | null) {
    this.ensureLoaded();
    const apiKey = this.data!.apiKeys.find(item => item.id === id);
    if (!apiKey) return;

    apiKey.totalRequests = Number(apiKey.totalRequests || 0) + 1;
    apiKey.updatedAt = nowIso();
    apiKey.lastUsedAt = nowIso();

    if (ok) {
      apiKey.successRequests = Number(apiKey.successRequests || 0) + 1;
      apiKey.lastFailureAt = null;
      apiKey.lastFailureReason = null;
    } else {
      apiKey.failedRequests = Number(apiKey.failedRequests || 0) + 1;
      apiKey.lastFailureAt = nowIso();
      apiKey.lastFailureReason = failureReason || "unknown error";
    }

    this.save();
  }

  isPathAllowedForApiKey(id: string, path: string) {
    this.ensureLoaded();
    const apiKey = this.data!.apiKeys.find(item => item.id === id);
    if (!apiKey) return { ok: false as const, reason: "API Key 无效" };

    const allowedPathPrefixes = Array.isArray(apiKey.allowedPathPrefixes) ? apiKey.allowedPathPrefixes.filter(Boolean) : [];
    if (allowedPathPrefixes.length === 0) return { ok: true as const };

    const matched = allowedPathPrefixes.some(prefix => path.startsWith(prefix));
    if (!matched) {
      return { ok: false as const, reason: `当前 API Key 不允许访问路径 ${path}` };
    }
    return { ok: true as const };
  }

  isModelAllowedForApiKey(id: string, model: string | null) {
    this.ensureLoaded();
    const apiKey = this.data!.apiKeys.find(item => item.id === id);
    if (!apiKey) return { ok: false as const, reason: "API Key 无效" };

    const allowedModels = Array.isArray(apiKey.allowedModels) ? apiKey.allowedModels.filter(Boolean) : [];
    if (allowedModels.length === 0 || !model) return { ok: true as const };

    if (!allowedModels.includes(model)) {
      return { ok: false as const, reason: `当前 API Key 不允许使用模型 ${model}` };
    }
    return { ok: true as const };
  }

  isKnownApiKey(rawKey: string) {
    this.ensureLoaded();
    return this.data!.apiKeys.some(apiKey => apiKey.key === rawKey);
  }

  isApiKeyRequired() {
    this.ensureLoaded();
    return this.data!.settings.requireApiKey;
  }

  getAdminApiKey() {
    this.ensureLoaded();
    return this.data!.settings.adminApiKey || "";
  }

  hasManagedAccounts() {
    return this.listEnabledAccounts().length > 0;
  }
}

export default new RuntimeStore();
