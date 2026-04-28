import _ from "lodash";

import Request from "@/lib/request/Request.ts";
import Response from "@/lib/response/Response.ts";
import { buildAdminCookieValue, hasAdminAccess } from "@/lib/auth.ts";
import runtimeStore from "@/lib/runtime-store.ts";
import { getCredit, getTokenLiveStatus } from "@/api/controllers/core.ts";

function escapeHtml(value: string) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderAdminGatePage(errorMessage = "") {
  const errorBlock = errorMessage
    ? `<div class="error">${escapeHtml(errorMessage)}</div>`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>jimeng-api 管理入口</title>
    <style>
      :root {
        --bg: #f5efe5;
        --card: rgba(255, 251, 245, 0.94);
        --ink: #1f2a1f;
        --muted: #5a6457;
        --line: rgba(34, 51, 34, 0.14);
        --accent: #0d6b4d;
        --danger: #a33434;
        --shadow: 0 24px 60px rgba(71, 53, 38, 0.15);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(216, 138, 92, 0.18), transparent 28%),
          radial-gradient(circle at top right, rgba(73, 123, 101, 0.18), transparent 24%),
          linear-gradient(160deg, #f7f0e6 0%, #efe6d7 52%, #f5eee7 100%);
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        padding: 24px;
      }
      .panel {
        width: min(460px, 100%);
        background: var(--card);
        border: 1px solid rgba(255,255,255,0.6);
        border-radius: 28px;
        padding: 28px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(14px);
      }
      .eyebrow {
        font-size: 12px;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--accent);
      }
      h1 {
        margin: 12px 0 10px;
        font: 700 34px/1.05 "Iowan Old Style", "Palatino Linotype", serif;
      }
      p {
        margin: 0 0 18px;
        color: var(--muted);
        line-height: 1.7;
      }
      input, button {
        width: 100%;
        font: inherit;
      }
      input {
        padding: 13px 14px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.88);
        color: var(--ink);
      }
      button {
        margin-top: 12px;
        border: 0;
        border-radius: 999px;
        padding: 12px 16px;
        cursor: pointer;
        background: var(--accent);
        color: #fffdf8;
        font-weight: 700;
      }
      .error {
        margin-bottom: 14px;
        padding: 12px 14px;
        border-radius: 14px;
        background: rgba(163, 52, 52, 0.1);
        color: var(--danger);
      }
      .note {
        margin-top: 14px;
        font-size: 13px;
        color: var(--muted);
      }
      code {
        padding: 2px 5px;
        border-radius: 6px;
        background: rgba(31, 42, 31, 0.06);
      }
    </style>
  </head>
  <body>
    <form class="panel" id="unlockForm" method="GET" action="/page">
      <div class="eyebrow">jimeng-api / locked</div>
      <h1>管理页已加锁</h1>
      <p>当前服务已配置后台密钥。输入管理密钥后才能进入 <code>/page</code>，同域下的 <code>/admin/*</code> 请求也会同步放行。</p>
      ${errorBlock}
      <input id="unlockKey" name="admin_key" type="password" placeholder="请输入 x-admin-key" autocomplete="current-password" />
      <button type="submit">进入控制台</button>
      <div class="note">如果之前在浏览器里保存过密钥，会自动回填。</div>
    </form>
    <script>
      const input = document.getElementById("unlockKey");
      const saved = localStorage.getItem("jimeng-admin-key") || "";
      if (saved && !input.value) input.value = saved;
      document.getElementById("unlockForm").addEventListener("submit", function () {
        localStorage.setItem("jimeng-admin-key", input.value.trim());
      });
    </script>
  </body>
</html>`;
}

function renderAdminPage() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>jimeng-api 控制台</title>
    <style>
      :root {
        --bg: #f6efe4;
        --paper: rgba(255, 250, 243, 0.9);
        --card: rgba(255, 255, 255, 0.86);
        --ink: #1f2a1f;
        --muted: #5a6457;
        --line: rgba(34, 51, 34, 0.12);
        --accent: #0d6b4d;
        --accent-2: #c96a3d;
        --danger: #a33434;
        --shadow: 0 18px 48px rgba(71, 53, 38, 0.12);
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(216, 138, 92, 0.18), transparent 28%),
          radial-gradient(circle at top right, rgba(73, 123, 101, 0.18), transparent 24%),
          linear-gradient(160deg, #f7f0e6 0%, #efe6d7 52%, #f5eee7 100%);
        font-family: "Avenir Next", "Segoe UI", sans-serif;
      }
      .shell {
        max-width: 1320px;
        margin: 0 auto;
        padding: 32px 20px 56px;
      }
      .hero {
        background: var(--paper);
        border: 1px solid rgba(255,255,255,0.5);
        border-radius: 24px;
        padding: 28px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(14px);
      }
      .hero-top {
        display: flex;
        gap: 16px;
        justify-content: space-between;
        align-items: start;
        flex-wrap: wrap;
      }
      .eyebrow {
        font-size: 12px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--accent);
        margin-bottom: 8px;
      }
      h1 {
        margin: 0;
        font: 700 40px/1.02 "Iowan Old Style", "Palatino Linotype", serif;
      }
      .subtitle {
        max-width: 760px;
        margin: 12px 0 0;
        color: var(--muted);
        line-height: 1.6;
      }
      .admin-bar {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
      input, textarea, select, button {
        font: inherit;
      }
      input, textarea, select {
        width: 100%;
        padding: 11px 13px;
        border-radius: 12px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.88);
        color: var(--ink);
      }
      textarea {
        min-height: 92px;
        resize: vertical;
      }
      button {
        border: 0;
        border-radius: 999px;
        padding: 11px 16px;
        cursor: pointer;
        background: var(--accent);
        color: #fffdf8;
        font-weight: 600;
      }
      button.alt { background: #e7dccb; color: var(--ink); }
      button.warn { background: var(--danger); }
      button.ghost {
        background: transparent;
        border: 1px solid var(--line);
        color: var(--ink);
      }
      .cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 14px;
        margin-top: 22px;
      }
      .card {
        background: var(--card);
        border: 1px solid rgba(255,255,255,0.6);
        border-radius: 20px;
        padding: 18px;
        box-shadow: var(--shadow);
      }
      .metric {
        font: 700 28px/1 "Iowan Old Style", "Palatino Linotype", serif;
        margin-top: 10px;
      }
      .label {
        color: var(--muted);
        font-size: 13px;
      }
      .grid {
        display: grid;
        grid-template-columns: 1.05fr 1fr;
        gap: 18px;
        margin-top: 18px;
      }
      .wide {
        grid-column: 1 / -1;
      }
      .section-title {
        margin: 0 0 12px;
        font: 700 24px/1.1 "Iowan Old Style", "Palatino Linotype", serif;
      }
      .stack {
        display: grid;
        gap: 12px;
      }
      .row {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .table {
        margin-top: 14px;
        border: 1px solid var(--line);
        border-radius: 16px;
        overflow: hidden;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        padding: 12px 14px;
        text-align: left;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
        font-size: 14px;
      }
      th { color: var(--muted); background: rgba(255,255,255,0.45); }
      tr:last-child td { border-bottom: 0; }
      .pill {
        display: inline-flex;
        align-items: center;
        padding: 4px 9px;
        border-radius: 999px;
        background: rgba(13, 107, 77, 0.12);
        color: var(--accent);
        font-size: 12px;
        font-weight: 700;
      }
      .pill.off {
        background: rgba(163, 52, 52, 0.12);
        color: var(--danger);
      }
      .note {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.6;
      }
      .actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .status {
        margin-top: 12px;
        min-height: 22px;
        color: var(--muted);
      }
      code {
        padding: 2px 5px;
        border-radius: 6px;
        background: rgba(31, 42, 31, 0.06);
      }
      @media (max-width: 980px) {
        .cards, .grid, .row { grid-template-columns: 1fr; }
        h1 { font-size: 32px; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="hero">
        <div class="hero-top">
          <div>
            <div class="eyebrow">jimeng-api / console</div>
            <h1>账号池、API Key、调用入口放在同一块面板里。</h1>
            <p class="subtitle">布局参考 one-api / new-api 的“渠道 + 密钥 + 系统配置”思路，但保留这个项目的轻量特征：不引入前端框架，部署后直接访问 <code>/page</code> 管理。</p>
          </div>
          <div class="admin-bar">
            <input id="adminKey" placeholder="如已配置，请输入 x-admin-key" />
            <button id="saveAdminKey">保存管理密钥</button>
            <button class="alt" id="reloadAll">刷新</button>
          </div>
        </div>

        <div class="cards" id="metrics">
          <div class="card"><div class="label">启用账号</div><div class="metric" id="metricAccounts">-</div></div>
          <div class="card"><div class="label">总账号数</div><div class="metric" id="metricAllAccounts">-</div></div>
          <div class="card"><div class="label">冷却中的账号</div><div class="metric" id="metricCoolingAccounts">-</div></div>
          <div class="card"><div class="label">启用 API Key</div><div class="metric" id="metricKeys">-</div></div>
          <div class="card"><div class="label">API Key 鉴权</div><div class="metric" id="metricRequireKey">-</div></div>
        </div>
      </section>

      <div class="grid">
        <section class="card">
          <h2 class="section-title">系统设置</h2>
          <div class="stack">
            <label>
              <div class="label">调用鉴权开关</div>
              <select id="requireApiKey">
                <option value="false">关闭，兼容旧模式</option>
                <option value="true">开启，业务接口要求 API Key</option>
              </select>
            </label>
            <label>
              <div class="label">管理后台密钥</div>
              <input id="adminApiKeySetting" placeholder="留空表示管理接口不额外鉴权" />
            </label>
            <div class="actions">
              <button id="saveSettings">保存设置</button>
            </div>
            <div class="note">业务接口鉴权使用 <code>x-api-key</code>。如果你仍想临时直传 session token，继续用 <code>Authorization: Bearer sessionid</code> 即可；当管理后台已有账号时，也可以不传上游 token。</div>
          </div>
        </section>

        <section class="card">
          <h2 class="section-title">调用示例</h2>
          <div class="note" id="usageExample">加载中...</div>
        </section>
      </div>

      <div class="grid">
        <section class="card">
          <h2 class="section-title">账号池</h2>
          <div class="stack">
            <div class="row">
              <label>
                <div class="label">账号名称</div>
                <input id="accountName" placeholder="例如：主号 / 美区1" />
              </label>
              <label>
                <div class="label">启用状态</div>
                <select id="accountEnabled">
                  <option value="true">启用</option>
                  <option value="false">停用</option>
                </select>
              </label>
            </div>
            <label>
              <div class="label">账号权重</div>
              <input id="accountWeight" placeholder="1-10，越大越容易被选中" />
            </label>
            <label>
              <div class="label">session token</div>
              <input id="accountToken" placeholder="支持 us-/hk-/jp-/sg- 前缀，也支持 proxy@token 格式" />
            </label>
            <label>
              <div class="label">备注</div>
              <textarea id="accountNotes" placeholder="可记录区域、用途、代理说明"></textarea>
            </label>
            <div class="actions">
              <button id="saveAccount">新增账号</button>
              <button class="ghost" id="cancelAccountEdit" style="display:none;">取消编辑</button>
            </div>
          </div>
          <div class="table">
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>区域</th>
                  <th>Token</th>
                  <th>运行状态</th>
                  <th>权重</th>
                  <th>最近使用</th>
                  <th>失败信息</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody id="accountsTable"></tbody>
            </table>
          </div>
        </section>

        <section class="card">
          <h2 class="section-title">API Key</h2>
          <div class="stack">
            <div class="row">
              <label>
                <div class="label">Key 名称</div>
                <input id="keyName" placeholder="例如：n8n / next-app / internal" />
              </label>
              <label>
                <div class="label">启用状态</div>
                <select id="keyEnabled">
                  <option value="true">启用</option>
                  <option value="false">停用</option>
                </select>
              </label>
            </div>
            <label>
              <div class="label">自定义 API Key</div>
              <input id="keyValue" placeholder="留空自动生成 jm_xxx" />
            </label>
            <div class="row">
              <label>
                <div class="label">总配额</div>
                <input id="keyTotalQuota" placeholder="留空表示不限制" />
              </label>
              <label>
                <div class="label">每分钟限流</div>
                <input id="keyRequestsPerMinute" placeholder="留空表示不限制" />
              </label>
            </div>
            <div class="row">
              <label>
                <div class="label">允许路径前缀</div>
                <input id="keyAllowedPaths" placeholder="例如：/v1/images,/v1/videos" />
              </label>
              <label>
                <div class="label">允许模型</div>
                <input id="keyAllowedModels" placeholder="例如：jimeng-4.5,jimeng-video-3.5-pro" />
              </label>
            </div>
            <div class="row">
              <label>
                <div class="label">过期时间</div>
                <input id="keyExpiresAt" type="datetime-local" />
              </label>
              <label>
                <div class="label">吊销/恢复备注</div>
                <input id="keyRevokeReason" placeholder="可选，吊销或恢复时记录原因" />
              </label>
            </div>
            <div class="actions">
              <button id="saveKey">新增 API Key</button>
              <button class="ghost" id="cancelKeyEdit" style="display:none;">取消编辑</button>
            </div>
          </div>
          <div class="table">
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>Key</th>
                  <th>状态 / 配额</th>
                  <th>统计</th>
                  <th>最近使用</th>
                  <th>最近失败</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody id="keysTable"></tbody>
            </table>
          </div>
        </section>
      </div>

      <div class="grid">
        <section class="card wide">
          <h2 class="section-title">24 小时统计</h2>
          <div class="stack">
            <div class="row">
              <label>
                <div class="label">按账号筛选</div>
                <select id="statsAccountFilter"></select>
              </label>
              <label>
                <div class="label">按 API Key 筛选</div>
                <select id="statsApiKeyFilter"></select>
              </label>
            </div>
            <div class="actions">
              <button id="applyStatsFilter">刷新统计</button>
              <button class="ghost" id="resetStatsFilter">重置筛选</button>
            </div>
            <div class="cards">
              <div class="card"><div class="label">24h 请求数</div><div class="metric" id="statsTotalRequests">-</div></div>
              <div class="card"><div class="label">24h 成功</div><div class="metric" id="statsSuccessfulRequests">-</div></div>
              <div class="card"><div class="label">24h 失败</div><div class="metric" id="statsFailedRequests">-</div></div>
              <div class="card"><div class="label">平均耗时</div><div class="metric" id="statsAverageDuration">-</div></div>
            </div>
            <div class="table">
              <table>
                <thead>
                  <tr>
                    <th>路径</th>
                    <th>总数</th>
                    <th>成功</th>
                    <th>失败</th>
                  </tr>
                </thead>
                <tbody id="statsPathTable"></tbody>
              </table>
            </div>
          </div>
        </section>
      </div>

      <div class="grid">
        <section class="card wide">
          <h2 class="section-title">最近请求</h2>
          <div class="table">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>请求</th>
                  <th>来源</th>
                  <th>账号/API Key</th>
                  <th>结果</th>
                  <th>耗时</th>
                  <th>错误</th>
                </tr>
              </thead>
              <tbody id="logsTable"></tbody>
            </table>
          </div>
        </section>
      </div>

      <div class="status" id="statusBar"></div>
    </div>

    <script>
      const statusBar = document.getElementById("statusBar");
      const adminKeyInput = document.getElementById("adminKey");
      const storedAdminKey = localStorage.getItem("jimeng-admin-key") || "";
      adminKeyInput.value = storedAdminKey;
      let editingKeyId = null;
      let editingAccountId = null;

      function setStatus(message, isError = false) {
        statusBar.textContent = message;
        statusBar.style.color = isError ? "var(--danger)" : "var(--muted)";
      }

      function headers(extra = {}) {
        const result = { "Content-Type": "application/json", ...extra };
        const key = adminKeyInput.value.trim();
        if (key) result["x-admin-key"] = key;
        return result;
      }

      async function request(url, options = {}) {
        const response = await fetch(url, {
          ...options,
          headers: headers(options.headers || {}),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error((data && (data.message || data.error)) || "请求失败");
        }
        if (data && data.code && data.code !== 0) {
          throw new Error(data.message || "请求失败");
        }
        return data && data.data ? data.data : data;
      }

      function boolText(value) {
        return value ? '<span class="pill">启用</span>' : '<span class="pill off">停用</span>';
      }

      function escapeHtml(value) {
        return String(value || "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function accountRuntimeText(account) {
        if (!account.enabled) return '<span class="pill off">停用</span>';
        if (account.coolingDown) return '<span class="pill off">冷却至 ' + escapeHtml(account.cooldownUntil || "-") + '</span>';
        return '<span class="pill">可用</span>';
      }

      function accountActions(account) {
        return [
          '<button class="ghost" onclick="editAccount(\\'' + account.id + '\\')">编辑</button>',
          '<button class="ghost" onclick="checkAccount(\\'' + account.id + '\\')">检测</button>',
          '<button class="ghost" onclick="resetAccountHealth(\\'' + account.id + '\\')">清除冷却</button>',
          '<button class="alt" onclick="toggleAccount(\\'' + account.id + '\\',' + (!account.enabled) + ')">' + (account.enabled ? '停用' : '启用') + '</button>',
          '<button class="warn" onclick="removeAccount(\\'' + account.id + '\\')">删除</button>'
        ].join("");
      }

      function keyActions(item) {
        return [
          '<button class="ghost" onclick="editKey(\\'' + item.id + '\\')">编辑</button>',
          '<button class="ghost" onclick="' + (item.revoked ? 'restoreKey' : 'revokeKey') + '(\\'' + item.id + '\\')">' + (item.revoked ? '恢复' : '吊销') + '</button>',
          '<button class="alt" onclick="toggleKey(\\'' + item.id + '\\',' + (!item.enabled) + ')">' + (item.enabled ? '停用' : '启用') + '</button>',
          '<button class="warn" onclick="removeKey(\\'' + item.id + '\\')">删除</button>'
        ].join("");
      }

      function parseOptionalList(value) {
        const text = String(value || "").trim();
        if (!text) return [];
        return text
          .split(/[\\n,]/)
          .map(item => item.trim())
          .filter(Boolean);
      }

      function resetKeyForm() {
        editingKeyId = null;
        document.getElementById("keyName").value = "";
        document.getElementById("keyValue").value = "";
        document.getElementById("keyEnabled").value = "true";
        document.getElementById("keyTotalQuota").value = "";
        document.getElementById("keyRequestsPerMinute").value = "";
        document.getElementById("keyAllowedPaths").value = "";
        document.getElementById("keyAllowedModels").value = "";
        document.getElementById("keyExpiresAt").value = "";
        document.getElementById("keyRevokeReason").value = "";
        document.getElementById("saveKey").textContent = "新增 API Key";
        document.getElementById("cancelKeyEdit").style.display = "none";
      }

      function toLocalDateTimeInput(value) {
        if (!value) return "";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "";
        const offset = date.getTimezoneOffset();
        const localDate = new Date(date.getTime() - offset * 60000);
        return localDate.toISOString().slice(0, 16);
      }

      function parseOptionalDateTime(value) {
        const trimmed = String(value || "").trim();
        if (!trimmed) return null;
        const date = new Date(trimmed);
        if (Number.isNaN(date.getTime())) {
          throw new Error("过期时间格式无效");
        }
        return date.toISOString();
      }

      function resetAccountForm() {
        editingAccountId = null;
        document.getElementById("accountName").value = "";
        document.getElementById("accountEnabled").value = "true";
        document.getElementById("accountWeight").value = "1";
        document.getElementById("accountToken").value = "";
        document.getElementById("accountNotes").value = "";
        document.getElementById("saveAccount").textContent = "新增账号";
        document.getElementById("cancelAccountEdit").style.display = "none";
      }

      function renderOverview(overview) {
        document.getElementById("metricAccounts").textContent = overview.stats.enabledAccountCount;
        document.getElementById("metricAllAccounts").textContent = overview.stats.accountCount;
        document.getElementById("metricCoolingAccounts").textContent = overview.stats.coolingAccountCount;
        document.getElementById("metricKeys").textContent = overview.stats.enabledApiKeyCount;
        document.getElementById("metricRequireKey").textContent = overview.settings.requireApiKey ? "ON" : "OFF";
        document.getElementById("requireApiKey").value = String(overview.settings.requireApiKey);
        document.getElementById("adminApiKeySetting").value = overview.settings.adminApiKey || "";
        renderStatsFilters(overview);

        document.getElementById("usageExample").innerHTML =
          '<pre style="white-space:pre-wrap;margin:0;">curl -X POST ' + window.location.origin + '/v1/images/generations \\\\n  -H "Content-Type: application/json" \\\\n  ' + (overview.settings.requireApiKey ? '-H "x-api-key: YOUR_API_KEY" \\\\n  ' : '') + '-d \\'{"prompt":"一张电影感海报","model":"jimeng-4.5"}\\'</pre>';

        document.getElementById("accountsTable").innerHTML = overview.accounts.map(account => (
          '<tr>' +
            '<td><strong>' + escapeHtml(account.name) + '</strong><div class="note">' + escapeHtml(account.notes || '-') + '</div></td>' +
            '<td><span class="pill">' + account.region + '</span>' + (account.proxyEnabled ? ' <span class="pill">Proxy</span>' : '') + '</td>' +
            '<td><code>' + escapeHtml(account.maskedToken || account.token) + '</code></td>' +
            '<td>' + accountRuntimeText(account) + '<div class="note">成功 ' + (account.successCount || 0) + ' / 失败 ' + (account.failureCount || 0) + '</div></td>' +
            '<td><span class="pill">' + escapeHtml(String(account.weight || 1)) + '</span></td>' +
            '<td>' + escapeHtml(account.lastUsedAt || '-') + '<div class="note">最近成功: ' + escapeHtml(account.lastSuccessAt || '-') + '</div></td>' +
            '<td>' + escapeHtml(account.lastFailureReason || '-') + '<div class="note">失败时间: ' + escapeHtml(account.lastFailureAt || '-') + '</div></td>' +
            '<td><div class="actions">' + accountActions(account) + '</div></td>' +
          '</tr>'
        )).join("") || '<tr><td colspan="8">还没有账号，新增后即可启用内部轮询。</td></tr>';

        document.getElementById("keysTable").innerHTML = overview.apiKeys.map(item => (
          '<tr>' +
            '<td><strong>' + escapeHtml(item.name) + '</strong></td>' +
            '<td><code>' + escapeHtml(item.maskedKey) + '</code><div class="note">明文仅在创建成功时返回一次</div></td>' +
            '<td>' + boolText(item.enabled)
              + '<div class="note">状态: ' + escapeHtml(item.revoked ? '已吊销' : (item.expired ? '已过期' : '可用')) + '</div>'
              + '<div class="note">总配额: ' + escapeHtml(item.totalQuota == null ? '∞' : String(item.totalQuota))
              + '，剩余: ' + escapeHtml(item.quotaRemaining == null ? '∞' : String(item.quotaRemaining))
              + '</div><div class="note">分钟限流: ' + escapeHtml(item.requestsPerMinute == null ? '∞' : String(item.requestsPerMinute))
              + '，当前剩余: ' + escapeHtml(item.minuteRemaining == null ? '∞' : String(item.minuteRemaining))
              + '</div><div class="note">路径: ' + escapeHtml((item.allowedPathPrefixes || []).join(", ") || "全部")
              + '</div><div class="note">模型: ' + escapeHtml((item.allowedModels || []).join(", ") || "全部")
              + '</div><div class="note">过期: ' + escapeHtml(item.expiresAt || '永不过期') + '</div></td>' +
            '<td>总请求 ' + escapeHtml(String(item.totalRequests || 0))
              + '<div class="note">成功 ' + escapeHtml(String(item.successRequests || 0)) + ' / 失败 ' + escapeHtml(String(item.failedRequests || 0))
              + '</div><div class="note">24h: ' + escapeHtml(String(item.recent24hRequests || 0))
              + ' 次，失败 ' + escapeHtml(String(item.recent24hFailures || 0)) + '</div></td>' +
            '<td>' + escapeHtml(item.lastUsedAt || '-') + '</td>' +
            '<td>' + escapeHtml(item.revoked ? (item.revokeReason || 'manual revoke') : (item.lastFailureReason || '-'))
              + '<div class="note">' + escapeHtml(item.revokedAt || item.lastFailureAt || '-') + '</div>'
              + '<div class="note">吊销记录: ' + escapeHtml(String((item.revokeHistory || []).length)) + '</div></td>' +
            '<td><div class="actions">' + keyActions(item) + '</div></td>' +
          '</tr>'
        )).join("") || '<tr><td colspan="7">还没有 API Key。</td></tr>';

        document.getElementById("logsTable").innerHTML = (overview.requestLogs || []).map(log => (
          '<tr>' +
            '<td>' + escapeHtml(log.time) + '</td>' +
            '<td><code>' + escapeHtml(log.method + " " + log.path) + '</code></td>' +
            '<td><span class="pill' + (log.source === "managed" ? "" : ' off') + '">' + escapeHtml(log.source) + '</span></td>' +
            '<td>' + escapeHtml((log.accountName || '-') + " / " + (log.apiKeyName || '-')) + '</td>' +
            '<td>' + (log.ok ? '<span class="pill">OK ' + escapeHtml(String(log.statusCode)) + '</span>' : '<span class="pill off">ERR ' + escapeHtml(String(log.statusCode)) + '</span>') + '</td>' +
            '<td>' + escapeHtml(String(log.durationMs)) + ' ms</td>' +
            '<td>' + escapeHtml(log.errorMessage || '-') + '</td>' +
          '</tr>'
        )).join("") || '<tr><td colspan="7">暂无请求记录。</td></tr>';
      }

      function renderStatsFilters(overview) {
        const accountFilter = document.getElementById("statsAccountFilter");
        const apiKeyFilter = document.getElementById("statsApiKeyFilter");
        const currentAccount = accountFilter.value;
        const currentApiKey = apiKeyFilter.value;
        accountFilter.innerHTML = '<option value="">全部账号</option>' + (overview.accounts || []).map(account =>
          '<option value="' + escapeHtml(account.id) + '">' + escapeHtml(account.name) + '</option>'
        ).join("");
        apiKeyFilter.innerHTML = '<option value="">全部 API Key</option>' + (overview.apiKeys || []).map(item =>
          '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.name) + '</option>'
        ).join("");
        accountFilter.value = currentAccount || "";
        apiKeyFilter.value = currentApiKey || "";
      }

      async function loadStats() {
        const accountId = document.getElementById("statsAccountFilter").value;
        const apiKeyId = document.getElementById("statsApiKeyFilter").value;
        const query = new URLSearchParams();
        if (accountId) query.set("accountId", accountId);
        if (apiKeyId) query.set("apiKeyId", apiKeyId);
        const stats = await request("/admin/stats" + (query.toString() ? ("?" + query.toString()) : ""), { method: "GET" });
        document.getElementById("statsTotalRequests").textContent = stats.totalRequests;
        document.getElementById("statsSuccessfulRequests").textContent = stats.successfulRequests;
        document.getElementById("statsFailedRequests").textContent = stats.failedRequests;
        document.getElementById("statsAverageDuration").textContent = stats.averageDurationMs + "ms";
        document.getElementById("statsPathTable").innerHTML = (stats.groupedByPath || []).map(item => (
          '<tr>' +
            '<td><code>' + escapeHtml(item.path) + '</code></td>' +
            '<td>' + escapeHtml(String(item.total)) + '</td>' +
            '<td>' + escapeHtml(String(item.success)) + '</td>' +
            '<td>' + escapeHtml(String(item.failed)) + '</td>' +
          '</tr>'
        )).join("") || '<tr><td colspan="4">当前筛选条件下暂无请求。</td></tr>';
      }

      async function loadOverview() {
        setStatus("加载管理数据...");
        const overview = await request("/admin/overview", { method: "GET" });
        renderOverview(overview);
        setStatus("管理数据已刷新");
      }

      document.getElementById("saveAdminKey").onclick = () => {
        localStorage.setItem("jimeng-admin-key", adminKeyInput.value.trim());
        setStatus("本地管理密钥已保存");
      };

      document.getElementById("reloadAll").onclick = async () => {
        try { await loadOverview(); } catch (error) { setStatus(error.message, true); }
      };

      document.getElementById("saveSettings").onclick = async () => {
        try {
          const nextAdminKey = document.getElementById("adminApiKeySetting").value.trim();
          await request("/admin/settings", {
            method: "POST",
            body: JSON.stringify({
              requireApiKey: document.getElementById("requireApiKey").value === "true",
              adminApiKey: nextAdminKey
            })
          });
          adminKeyInput.value = nextAdminKey;
          if (nextAdminKey) localStorage.setItem("jimeng-admin-key", nextAdminKey);
          else localStorage.removeItem("jimeng-admin-key");
          await loadOverview();
          setStatus("系统设置已保存");
        } catch (error) {
          setStatus(error.message, true);
        }
      };

      document.getElementById("saveAccount").onclick = async () => {
        try {
          const payload = {
            name: document.getElementById("accountName").value.trim(),
            token: document.getElementById("accountToken").value.trim(),
            enabled: document.getElementById("accountEnabled").value === "true",
            weight: parseAccountWeight(document.getElementById("accountWeight").value),
            notes: document.getElementById("accountNotes").value.trim()
          };
          const isEditing = !!editingAccountId;
          await request(isEditing ? ("/admin/accounts/" + editingAccountId) : "/admin/accounts", {
            method: isEditing ? "PUT" : "POST",
            body: JSON.stringify({
              ...payload,
              token: isEditing && !payload.token ? undefined : payload.token
            })
          });
          resetAccountForm();
          await loadOverview();
          await loadStats();
          setStatus(isEditing ? "账号已更新" : "账号已保存");
        } catch (error) {
          setStatus(error.message, true);
        }
      };

      document.getElementById("saveKey").onclick = async () => {
        try {
          const payload = {
            name: document.getElementById("keyName").value.trim(),
            key: document.getElementById("keyValue").value.trim(),
            enabled: document.getElementById("keyEnabled").value === "true",
            totalQuota: parseOptionalInteger(document.getElementById("keyTotalQuota").value),
            requestsPerMinute: parseOptionalInteger(document.getElementById("keyRequestsPerMinute").value),
            allowedPathPrefixes: parseOptionalList(document.getElementById("keyAllowedPaths").value),
            allowedModels: parseOptionalList(document.getElementById("keyAllowedModels").value),
            expiresAt: parseOptionalDateTime(document.getElementById("keyExpiresAt").value)
          };
          const isEditing = !!editingKeyId;
          const created = await request(isEditing ? ("/admin/api-keys/" + editingKeyId) : "/admin/api-keys", {
            method: isEditing ? "PUT" : "POST",
            body: JSON.stringify({
              ...payload,
              key: isEditing && !payload.key ? undefined : payload.key
            })
          });
          resetKeyForm();
          await loadOverview();
          setStatus(isEditing ? "API Key 已更新" : ("API Key 已保存，请立即记录: " + created.key));
        } catch (error) {
          setStatus(error.message, true);
        }
      };

      function parseOptionalInteger(value) {
        const trimmed = String(value || "").trim();
        if (!trimmed) return null;
        const parsed = Number.parseInt(trimmed, 10);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error("配额和限流必须是大于 0 的整数");
        }
        return parsed;
      }

      function parseAccountWeight(value) {
        const trimmed = String(value || "").trim();
        if (!trimmed) return 1;
        const parsed = Number.parseInt(trimmed, 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
          throw new Error("账号权重必须是 1 到 10 的整数");
        }
        return parsed;
      }

      document.getElementById("cancelKeyEdit").onclick = () => {
        resetKeyForm();
        setStatus("已取消 API Key 编辑");
      };
      document.getElementById("cancelAccountEdit").onclick = () => {
        resetAccountForm();
        setStatus("已取消账号编辑");
      };
      document.getElementById("applyStatsFilter").onclick = () => loadStats().catch(error => setStatus(error.message, true));
      document.getElementById("resetStatsFilter").onclick = () => {
        document.getElementById("statsAccountFilter").value = "";
        document.getElementById("statsApiKeyFilter").value = "";
        loadStats().catch(error => setStatus(error.message, true));
      };

      window.removeAccount = async function (id) {
        try {
          await request("/admin/accounts/" + id, { method: "DELETE" });
          await loadOverview();
          await loadStats();
          if (editingAccountId === id) resetAccountForm();
          setStatus("账号已删除");
        } catch (error) {
          setStatus(error.message, true);
        }
      };

      window.toggleAccount = async function (id, enabled) {
        try {
          await request("/admin/accounts/" + id, {
            method: "PUT",
            body: JSON.stringify({ enabled })
          });
          await loadOverview();
          await loadStats();
          setStatus("账号状态已更新");
        } catch (error) {
          setStatus(error.message, true);
        }
      };

      window.checkAccount = async function (id) {
        try {
          const result = await request("/admin/accounts/" + id + "/check", { method: "POST" });
          setStatus("检测完成: live=" + result.live + ", credit=" + (result.credit ? result.credit.totalCredit : "N/A"));
        } catch (error) {
          setStatus(error.message, true);
        }
      };

      window.resetAccountHealth = async function (id) {
        try {
          await request("/admin/accounts/" + id + "/reset", { method: "POST" });
          await loadOverview();
          setStatus("账号冷却状态已清除");
        } catch (error) {
          setStatus(error.message, true);
        }
      };

      window.editAccount = async function (id) {
        try {
          const overview = await request("/admin/overview", { method: "GET" });
          const target = (overview.accounts || []).find(item => item.id === id);
          if (!target) throw new Error("账号不存在");
          editingAccountId = id;
          document.getElementById("accountName").value = target.name || "";
          document.getElementById("accountEnabled").value = String(!!target.enabled);
          document.getElementById("accountWeight").value = String(target.weight || 1);
          document.getElementById("accountToken").value = "";
          document.getElementById("accountNotes").value = target.notes || "";
          document.getElementById("saveAccount").textContent = "更新账号";
          document.getElementById("cancelAccountEdit").style.display = "inline-flex";
          setStatus("已载入账号配置，修改后保存");
        } catch (error) {
          setStatus(error.message, true);
        }
      };

      window.removeKey = async function (id) {
        try {
          await request("/admin/api-keys/" + id, { method: "DELETE" });
          await loadOverview();
          await loadStats();
          if (editingKeyId === id) resetKeyForm();
          setStatus("API Key 已删除");
        } catch (error) {
          setStatus(error.message, true);
        }
      };

      window.toggleKey = async function (id, enabled) {
        try {
          await request("/admin/api-keys/" + id, {
            method: "PUT",
            body: JSON.stringify({ enabled })
          });
          await loadOverview();
          await loadStats();
          setStatus("API Key 状态已更新");
        } catch (error) {
          setStatus(error.message, true);
        }
      };

      window.revokeKey = async function (id) {
        try {
          await request("/admin/api-keys/" + id + "/revoke", {
            method: "POST",
            body: JSON.stringify({
              reason: document.getElementById("keyRevokeReason").value.trim()
            })
          });
          await loadOverview();
          await loadStats();
          setStatus("API Key 已吊销");
        } catch (error) {
          setStatus(error.message, true);
        }
      };

      window.restoreKey = async function (id) {
        try {
          await request("/admin/api-keys/" + id + "/restore", {
            method: "POST",
            body: JSON.stringify({
              reason: document.getElementById("keyRevokeReason").value.trim()
            })
          });
          await loadOverview();
          await loadStats();
          setStatus("API Key 已恢复");
        } catch (error) {
          setStatus(error.message, true);
        }
      };

      window.editKey = async function (id) {
        try {
          const overview = await request("/admin/overview", { method: "GET" });
          const target = (overview.apiKeys || []).find(item => item.id === id);
          if (!target) throw new Error("API Key 不存在");
          editingKeyId = id;
          document.getElementById("keyName").value = target.name || "";
          document.getElementById("keyValue").value = "";
          document.getElementById("keyEnabled").value = String(!!target.enabled);
          document.getElementById("keyTotalQuota").value = target.totalQuota == null ? "" : String(target.totalQuota);
          document.getElementById("keyRequestsPerMinute").value = target.requestsPerMinute == null ? "" : String(target.requestsPerMinute);
          document.getElementById("keyAllowedPaths").value = (target.allowedPathPrefixes || []).join(", ");
          document.getElementById("keyAllowedModels").value = (target.allowedModels || []).join(", ");
          document.getElementById("keyExpiresAt").value = toLocalDateTimeInput(target.expiresAt);
          document.getElementById("keyRevokeReason").value = target.revokeReason || "";
          document.getElementById("saveKey").textContent = "更新 API Key";
          document.getElementById("cancelKeyEdit").style.display = "inline-flex";
          setStatus("已载入 API Key 配置，修改后保存");
        } catch (error) {
          setStatus(error.message, true);
        }
      };

      resetKeyForm();
      resetAccountForm();
      loadOverview().then(loadStats).catch(error => setStatus(error.message, true));
    </script>
  </body>
</html>`;
}

export default {
  get: {
    "/page": async (request: Request) => {
      const configuredAdminKey = runtimeStore.getAdminApiKey();
      if (!configuredAdminKey) return new Response(renderAdminPage(), { type: "html" });

      const queryAdminKey = _.isString(request.query.admin_key) ? request.query.admin_key.trim() : "";
      if (!hasAdminAccess(request, configuredAdminKey)) {
        return new Response(
          renderAdminGatePage(queryAdminKey ? "管理密钥无效，请重新输入。" : ""),
          { type: "html", statusCode: 401 }
        );
      }

      return new Response(renderAdminPage(), {
        type: "html",
        headers: queryAdminKey === configuredAdminKey
          ? { "Set-Cookie": buildAdminCookieValue(configuredAdminKey) }
          : undefined,
      });
    },

    "/admin/bootstrap": async () => runtimeStore.getAdminBootstrap(),

    "/admin/overview": async () => runtimeStore.getOverview(),

    "/admin/stats": async (request: Request) => {
      request
        .validate("query.accountId", value => _.isUndefined(value) || _.isString(value))
        .validate("query.apiKeyId", value => _.isUndefined(value) || _.isString(value));
      return runtimeStore.getRequestStats({
        accountId: request.query.accountId,
        apiKeyId: request.query.apiKeyId,
        windowHours: 24,
      });
    },
  },

  post: {
    "/admin/settings": async (request: Request) => {
      request
        .validate("body.requireApiKey", value => _.isUndefined(value) || _.isBoolean(value))
        .validate("body.adminApiKey", value => _.isUndefined(value) || _.isString(value));
      return runtimeStore.updateSettings({
        requireApiKey: request.body.requireApiKey,
        adminApiKey: request.body.adminApiKey,
      });
    },

    "/admin/accounts": async (request: Request) => {
      request
        .validate("body.name", value => _.isString(value) && value.trim().length > 0)
        .validate("body.token", value => _.isString(value) && value.trim().length > 0)
        .validate("body.enabled", value => _.isUndefined(value) || _.isBoolean(value))
        .validate("body.weight", value => _.isUndefined(value) || (_.isFinite(value) && Number(value) >= 1 && Number(value) <= 10))
        .validate("body.notes", value => _.isUndefined(value) || _.isString(value));
      return runtimeStore.upsertAccount({
        name: request.body.name,
        token: request.body.token,
        enabled: request.body.enabled,
        weight: request.body.weight,
        notes: request.body.notes,
      });
    },

    "/admin/accounts/:id/check": async (request: Request) => {
      request.validate("params.id", value => _.isString(value) && value.length > 0);
      const account = runtimeStore.getAccountById(request.params.id);
      if (!account) throw new Error("账号不存在");
      const live = await getTokenLiveStatus(account.token);
      let credit = null;
      try {
        credit = await getCredit(account.token);
      } catch (error) {
        credit = {
          error: error.message,
        };
      }
      return {
        id: account.id,
        name: account.name,
        live,
        credit,
      };
    },

    "/admin/accounts/:id/reset": async (request: Request) => {
      request.validate("params.id", value => _.isString(value) && value.length > 0);
      const account = runtimeStore.resetAccountHealth(request.params.id);
      if (!account) throw new Error("账号不存在");
      return account;
    },

    "/admin/api-keys": async (request: Request) => {
      request
        .validate("body.name", value => _.isString(value) && value.trim().length > 0)
        .validate("body.key", value => _.isUndefined(value) || _.isString(value))
        .validate("body.enabled", value => _.isUndefined(value) || _.isBoolean(value))
        .validate("body.totalQuota", value => _.isUndefined(value) || _.isNull(value) || (_.isFinite(value) && Number(value) > 0))
        .validate("body.requestsPerMinute", value => _.isUndefined(value) || _.isNull(value) || (_.isFinite(value) && Number(value) > 0))
        .validate("body.allowedPathPrefixes", value => _.isUndefined(value) || (_.isArray(value) && value.every(_.isString)))
        .validate("body.allowedModels", value => _.isUndefined(value) || (_.isArray(value) && value.every(_.isString)))
        .validate("body.expiresAt", value => _.isUndefined(value) || _.isNull(value) || _.isString(value));
      return runtimeStore.upsertApiKey({
        name: request.body.name,
        key: request.body.key,
        enabled: request.body.enabled,
        totalQuota: request.body.totalQuota,
        requestsPerMinute: request.body.requestsPerMinute,
        allowedPathPrefixes: request.body.allowedPathPrefixes,
        allowedModels: request.body.allowedModels,
        expiresAt: request.body.expiresAt,
      });
    },

    "/admin/api-keys/:id/revoke": async (request: Request) => {
      request
        .validate("params.id", value => _.isString(value) && value.length > 0)
        .validate("body.reason", value => _.isUndefined(value) || _.isString(value));
      const updated = runtimeStore.revokeApiKey(request.params.id, request.body.reason);
      if (!updated) throw new Error("API Key 不存在");
      return updated;
    },

    "/admin/api-keys/:id/restore": async (request: Request) => {
      request
        .validate("params.id", value => _.isString(value) && value.length > 0)
        .validate("body.reason", value => _.isUndefined(value) || _.isString(value));
      const updated = runtimeStore.restoreApiKey(request.params.id, request.body.reason);
      if (!updated) throw new Error("API Key 不存在");
      return updated;
    },
  },

  put: {
    "/admin/accounts/:id": async (request: Request) => {
      request
        .validate("params.id", value => _.isString(value) && value.length > 0)
        .validate("body.name", value => _.isUndefined(value) || (_.isString(value) && value.trim().length > 0))
        .validate("body.token", value => _.isUndefined(value) || _.isString(value))
        .validate("body.enabled", value => _.isUndefined(value) || _.isBoolean(value))
        .validate("body.weight", value => _.isUndefined(value) || (_.isFinite(value) && Number(value) >= 1 && Number(value) <= 10))
        .validate("body.notes", value => _.isUndefined(value) || _.isString(value));

      const current = runtimeStore.getAccountById(request.params.id);
      if (!current) throw new Error("账号不存在");
      return runtimeStore.upsertAccount({
        id: request.params.id,
        name: request.body.name || current.name,
        token: request.body.token,
        enabled: request.body.enabled,
        weight: request.body.weight,
        notes: request.body.notes,
      });
    },

    "/admin/api-keys/:id": async (request: Request) => {
      request
        .validate("params.id", value => _.isString(value) && value.length > 0)
        .validate("body.name", value => _.isUndefined(value) || (_.isString(value) && value.trim().length > 0))
        .validate("body.key", value => _.isUndefined(value) || _.isString(value))
        .validate("body.enabled", value => _.isUndefined(value) || _.isBoolean(value))
        .validate("body.totalQuota", value => _.isUndefined(value) || _.isNull(value) || (_.isFinite(value) && Number(value) > 0))
        .validate("body.requestsPerMinute", value => _.isUndefined(value) || _.isNull(value) || (_.isFinite(value) && Number(value) > 0))
        .validate("body.allowedPathPrefixes", value => _.isUndefined(value) || (_.isArray(value) && value.every(_.isString)))
        .validate("body.allowedModels", value => _.isUndefined(value) || (_.isArray(value) && value.every(_.isString)))
        .validate("body.expiresAt", value => _.isUndefined(value) || _.isNull(value) || _.isString(value));

      const current = runtimeStore.getApiKeyById(request.params.id);
      if (!current) throw new Error("API Key 不存在");
      return runtimeStore.upsertApiKey({
        id: request.params.id,
        name: request.body.name || current.name,
        key: request.body.key,
        enabled: request.body.enabled,
        totalQuota: request.body.totalQuota,
        requestsPerMinute: request.body.requestsPerMinute,
        allowedPathPrefixes: request.body.allowedPathPrefixes,
        allowedModels: request.body.allowedModels,
        expiresAt: request.body.expiresAt,
      });
    },
  },

  delete: {
    "/admin/accounts/:id": async (request: Request) => {
      request.validate("params.id", value => _.isString(value) && value.length > 0);
      runtimeStore.deleteAccount(request.params.id);
      return {
        ok: true,
      };
    },

    "/admin/api-keys/:id": async (request: Request) => {
      request.validate("params.id", value => _.isString(value) && value.length > 0);
      runtimeStore.deleteApiKey(request.params.id);
      return {
        ok: true,
      };
    },
  },
};
