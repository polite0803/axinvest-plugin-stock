// SPDX-License-Identifier: AGPL-3.0-only
//
// T3 原生 bundle 视图：模拟观察（持仓看板）。
//
// 数据来源只有一条已声明的读命令 `stock_get_portfolio_dashboard`（worker 侧经
// `stock.analysis` 接缝调宿主 R2 组合监控）。bundle 不依赖 React / antd / store，
// 中文文案自带；不继承宿主主题 token，颜色走 index.html 的本地 CSS 变量。
//
// ⚠ 与 crossMarket.ts 同构：页面生命周期（announceReady / dispose）留在 main.ts
// 顶层唯一一处；本模块只负责装载、刷新与卸载自身的监听。

import type { AxAgentPluginClient } from "../vendor/sdk/pluginClientBridge";

const COMMAND_DASHBOARD = "stock_get_portfolio_dashboard";

/** 只取渲染所需字段；其余字段原样忽略，避免把缺失字段伪装成 0。 */
interface Dashboard {
  totalMarketValue?: number;
  totalPnl?: number;
  totalPnlPct?: number;
  riskLevel?: string;
  diversificationScore?: number;
  topConcentrationPct?: number;
  unpricedPositions?: number;
  concentrationWarning?: string;
  positions?: readonly PositionRow[];
  sectorExposure?: Record<string, number>;
  stressTest?: Record<string, unknown>;
  asOfDate?: string;
  isHistorical?: boolean;
}

interface PositionRow {
  code?: string;
  name?: string;
  quantity?: number;
  costBasis?: number;
  lastPrice?: number;
  marketValue?: number;
  unrealizedPnl?: number;
  [key: string]: unknown;
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string") {
    return raw;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function money(value: unknown): string {
  const n = number(value);
  return n === null ? "—" : n.toFixed(2);
}

function percent(value: unknown): string {
  const n = number(value);
  return n === null ? "—" : `${n.toFixed(2)}%`;
}

function text(value: unknown): string {
  return typeof value === "string" && value !== "" ? value : "—";
}

/** 一个取数区：loading / error / empty / 数据四态分列，区之间互不覆盖。 */
function renderSection(
  host: HTMLElement,
  state: "loading" | "error" | "empty" | "ready",
  detail: string,
  content?: HTMLElement,
): void {
  host.replaceChildren();
  const section = document.createElement("section");
  section.className = "x-section";
  if (state === "loading") {
    const p = document.createElement("p");
    p.className = "x-empty";
    p.textContent = "取数中…";
    section.appendChild(p);
  } else if (state === "error") {
    const p = document.createElement("p");
    p.className = "x-error";
    p.textContent = `调用失败：${detail}`;
    section.appendChild(p);
  } else if (state === "empty") {
    const p = document.createElement("p");
    p.className = "x-empty";
    p.textContent = detail;
    section.appendChild(p);
  } else if (content) {
    section.appendChild(content);
  }
  host.appendChild(section);
}

function summaryCards(d: Dashboard): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "p-summary";
  const cards: readonly (readonly [string, string])[] = [
    ["总市值", money(d.totalMarketValue)],
    ["浮动盈亏", money(d.totalPnl)],
    ["收益率", percent(d.totalPnlPct)],
    ["风险等级", text(d.riskLevel)],
    ["分散度", d.diversificationScore === undefined ? "—" : String(d.diversificationScore)],
    ["最大集中度", percent(d.topConcentrationPct)],
    ["未定价持仓", d.unpricedPositions === undefined ? "—" : String(d.unpricedPositions)],
    ["快照日期", text(d.asOfDate)],
  ];
  for (const [label, value] of cards) {
    const card = document.createElement("div");
    card.className = "p-card";
    const key = document.createElement("span");
    key.textContent = label;
    const val = document.createElement("strong");
    val.textContent = value;
    card.append(key, val);
    wrap.appendChild(card);
  }
  return wrap;
}

/** 持仓表：字段缺失显示破折号，不把缺值当 0；无持仓时由调用方渲染空态。 */
function positionsTable(rows: readonly PositionRow[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "p-table-wrap";
  const table = document.createElement("table");
  table.className = "p-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  const columns = ["代码", "名称", "数量", "成本", "现价", "市值", "浮动盈亏"];
  for (const label of columns) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  table.appendChild(head);

  const body = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    const cells = [
      text(row.code),
      text(row.name),
      row.quantity === undefined ? "—" : String(row.quantity),
      money(row.costBasis),
      money(row.lastPrice),
      money(row.marketValue),
      money(row.unrealizedPnl),
    ];
    for (const value of cells) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  wrap.appendChild(table);
  return wrap;
}

/** 行业暴露：按最大占比归一化画条，名称与比例均来自回执，不臆造行业。 */
function sectorBars(exposure: Record<string, number>): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "p-sectors";
  const entries = Object.entries(exposure).filter(([, value]) => number(value) !== null);
  const max = Math.max(0, ...entries.map(([, value]) => number(value) ?? 0));
  for (const [name, value] of entries) {
    const ratio = max > 0 ? ((number(value) ?? 0) / max) * 100 : 0;
    const row = document.createElement("div");
    row.className = "p-sector";
    const label = document.createElement("span");
    label.textContent = name;
    const bar = document.createElement("span");
    bar.className = "p-sector-bar";
    const fill = document.createElement("span");
    fill.style.width = `${ratio.toFixed(1)}%`;
    bar.appendChild(fill);
    const pct = document.createElement("span");
    pct.textContent = percent(value);
    row.append(label, bar, pct);
    wrap.appendChild(row);
  }
  return wrap;
}

/** 压力测试：三个场景各自独立展示，缺项不补零。 */
function stressTests(stress: Record<string, unknown>): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "p-stress";
  const labels: readonly (readonly [string, string])[] = [
    ["m10", "下跌 10%"],
    ["m20", "下跌 20%"],
    ["blackSwan", "黑天鹅"],
  ];
  for (const [key, label] of labels) {
    const item = document.createElement("div");
    item.className = "p-stress-item";
    const value = stress[key];
    const valueText = isRecord(value)
      ? Object.entries(value).map(([k, v]) => `${k}: ${typeof v === "number" ? money(v) : String(v)}`).join(" · ")
      : value === undefined || value === null ? "无数据" : String(value);
    item.textContent = `${label}：${valueText}`;
    wrap.appendChild(item);
  }
  return wrap;
}

function renderDashboard(host: HTMLElement, raw: unknown): void {
  const value = parseJson(raw);
  if (!isRecord(value)) {
    renderSection(host, "empty", "本环境不提供该数据");
    return;
  }
  const d = value as Dashboard;
  const rows = Array.isArray(d.positions) ? d.positions : [];
  if (rows.length === 0 && number(d.totalMarketValue) === null) {
    renderSection(host, "empty", "暂无持仓数据");
    return;
  }

  const content = document.createElement("div");
  content.className = "p-content";
  content.appendChild(summaryCards(d));
  if (d.concentrationWarning) {
    const warn = document.createElement("p");
    warn.className = "x-error";
    warn.textContent = d.concentrationWarning;
    content.appendChild(warn);
  }

  const positionsSection = document.createElement("section");
  positionsSection.className = "x-section";
  const positionsTitle = document.createElement("h3");
  positionsTitle.textContent = `持仓明细（${rows.length}）`;
  positionsSection.appendChild(positionsTitle);
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "x-empty";
    empty.textContent = "暂无持仓";
    positionsSection.appendChild(empty);
  } else {
    positionsSection.appendChild(positionsTable(rows));
  }
  content.appendChild(positionsSection);

  if (d.sectorExposure && Object.keys(d.sectorExposure).length > 0) {
    const sectorSection = document.createElement("section");
    sectorSection.className = "x-section";
    const sectorTitle = document.createElement("h3");
    sectorTitle.textContent = "行业暴露";
    sectorSection.appendChild(sectorTitle);
    sectorSection.appendChild(sectorBars(d.sectorExposure));
    content.appendChild(sectorSection);
  }

  if (d.stressTest && Object.keys(d.stressTest).length > 0) {
    const stressSection = document.createElement("section");
    stressSection.className = "x-section";
    const stressTitle = document.createElement("h3");
    stressTitle.textContent = "压力测试";
    stressSection.appendChild(stressTitle);
    stressSection.appendChild(stressTests(d.stressTest));
    content.appendChild(stressSection);
  }

  renderSection(host, "ready", "", content);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

/**
 * 装载模拟观察页：刷新按钮显式触发；输入态留在组件内部。
 * 连续刷新只让最后一轮回包上屏，过期回包不碰宿主节点。
 */
export function mountPortfolio(root: HTMLElement, client: AxAgentPluginClient): () => void {
  const bar = document.createElement("div");
  bar.className = "x-form";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "刷新持仓";
  bar.appendChild(refresh);

  const host = document.createElement("div");
  host.className = "p-host";
  root.replaceChildren(bar, host);

  let disposed = false;
  let generation = 0;

  async function load(): Promise<void> {
    const round = ++generation;
    renderSection(host, "loading", "");
    try {
      const raw = await client.executeCommand({ name: COMMAND_DASHBOARD });
      if (disposed || round !== generation) {
        return;
      }
      renderDashboard(host, raw);
    } catch (error) {
      if (disposed || round !== generation) {
        return;
      }
      renderSection(host, "error", errorMessage(error));
    }
  }

  const onClick = (): void => {
    void load();
  };
  refresh.addEventListener("click", onClick);
  void load();

  return () => {
    disposed = true;
    ++generation;
    refresh.removeEventListener("click", onClick);
  };
}
