// SPDX-License-Identifier: AGPL-3.0-only
//
// T3 原生 bundle 视图：智能选股（只读数据面）。
//
// 全部命令已在 plugin-stock worker 声明；写操作（stock_start_task /
// stock_apply_reco_weights / stock_set_reco_board_scope）刻意不迁 —— 插件侧尚无完整的
// 任务台账与权重回写 UI，只迁读数，不做半截写链路。
//
// 与 crossMarket / quant 同构：生命周期留在 main.ts 顶层；连续刷新只让最后一轮回包上屏。

import type { AxAgentPluginClient } from "../vendor/sdk/pluginClientBridge";

const POOL_BATCH = "stock_get_reco_pool_batch";
const BOARD_SCOPE = "stock_get_reco_board_scope";
const HOT_STOCKS = "stock_get_hot_stocks";
const LIMIT_UP = "stock_get_limit_up_pool";
const DRAGON_TIGER = "stock_get_market_dragon_tiger";
const RECO_HISTORY = "stock_list_reco_history";
const LATEST_ANALYSES = "stock_get_latest_analyses_for_stocks";

/** 六条互相独立的只读命令，并发投递、各自结算。 */
const BASE_COMMANDS = [
  { name: POOL_BATCH, title: "实盘候选池批次", input: undefined },
  { name: BOARD_SCOPE, title: "扫描板块范围", input: undefined },
  { name: HOT_STOCKS, title: "热门股票榜", input: undefined },
  { name: LIMIT_UP, title: "涨停池", input: undefined },
  { name: DRAGON_TIGER, title: "全市场龙虎榜", input: undefined },
  { name: RECO_HISTORY, title: "荐股历史", input: { limit: 20, offset: 0 } },
] as const;

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

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

/** 一个取数区：loading / error / empty / skipped / ready 五态分列。 */
function renderSection(
  host: HTMLElement,
  state: "loading" | "error" | "empty" | "skipped" | "ready",
  detail: string,
  content?: HTMLElement,
): void {
  host.replaceChildren();
  const section = document.createElement("section");
  section.className = "x-section";
  if (state === "ready" && content) {
    section.appendChild(content);
  } else {
    const p = document.createElement("p");
    p.className = state === "error" ? "x-error" : "x-empty";
    const labels: Record<"loading" | "error" | "empty" | "skipped" | "ready", string> = {
      loading: "取数中…",
      error: `调用失败：${detail}`,
      empty: detail,
      skipped: detail,
      ready: detail,
    };
    p.textContent = labels[state];
    section.appendChild(p);
  }
  host.appendChild(section);
}

/** 数组回执取前若干行、前若干列做表；字段缺失显示破折号，不臆造列。 */
function listTable(rows: readonly Record<string, unknown>[], title: string, maxRows = 8): HTMLElement {
  const wrap = document.createElement("div");
  const h = document.createElement("h3");
  h.textContent = `${title}（${rows.length}）`;
  wrap.appendChild(h);
  const tableHost = document.createElement("div");
  tableHost.className = "p-table-wrap";
  const table = document.createElement("table");
  table.className = "p-table";
  const keys = Object.keys(rows[0] ?? {}).slice(0, 5);
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const key of keys) {
    const th = document.createElement("th");
    th.textContent = key;
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  table.appendChild(head);
  const body = document.createElement("tbody");
  for (const row of rows.slice(0, maxRows)) {
    const tr = document.createElement("tr");
    for (const key of keys) {
      const td = document.createElement("td");
      td.textContent = display(row[key]);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  tableHost.appendChild(table);
  wrap.appendChild(tableHost);
  return wrap;
}

function jsonBlock(value: unknown): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "x-json";
  pre.textContent = JSON.stringify(value, null, 2);
  return pre;
}

/** 候选池是单对象批次摘要；null 与 hasSnapshot=false 是两种不同缺席，分别呈现。 */
function renderPool(host: HTMLElement, raw: unknown): void {
  const value = parseJson(raw);
  if (!isRecord(value)) {
    renderSection(host, "empty", "该链暂无实盘批次留痕");
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "p-summary";
  const fields = ["generatedAt", "period", "stockCount", "degraded", "purpose", "hasSnapshot"];
  for (const key of fields) {
    const card = document.createElement("div");
    card.className = "p-card";
    const label = document.createElement("span");
    label.textContent = key;
    const val = document.createElement("strong");
    val.textContent = display(value[key]);
    card.append(label, val);
    wrap.appendChild(card);
  }
  renderSection(host, "ready", "", wrap);
}

/** 从热股榜回执提取代码；只收 6 位数字代码，避免把名称或乱串当入参发出去。 */
function stockCodes(raw: unknown): string[] {
  const value = parseJson(raw);
  if (!Array.isArray(value)) {
    return [];
  }
  const codes: string[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const candidate = item.stockCode ?? item.code ?? item.symbol;
    if (typeof candidate === "string" && /^\d{6}$/.test(candidate) && !codes.includes(candidate)) {
      codes.push(candidate);
    }
    if (codes.length === 5) {
      break;
    }
  }
  return codes;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

/**
 * 装载选股页：六条读数并发；级联的决策摘要从热股榜代码提取，提取不到显式跳过。
 */
export function mountScreener(root: HTMLElement, client: AxAgentPluginClient): () => void {
  const bar = document.createElement("div");
  bar.className = "x-form";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "刷新选股数据";
  bar.appendChild(refresh);

  const grid = document.createElement("div");
  grid.className = "x-grid";
  const hosts = new Map<string, HTMLElement>();
  for (const command of BASE_COMMANDS) {
    const host = document.createElement("div");
    hosts.set(command.name, host);
    grid.appendChild(host);
  }
  const detailHost = document.createElement("div");
  grid.appendChild(detailHost);
  root.replaceChildren(bar, grid);

  let disposed = false;
  let generation = 0;

  async function refreshData(): Promise<void> {
    const round = ++generation;
    for (const command of BASE_COMMANDS) {
      const host = hosts.get(command.name);
      if (host) {
        renderSection(host, "loading", "");
      }
    }
    renderSection(detailHost, "loading", "");

    const results = await Promise.all(BASE_COMMANDS.map(async (command) => {
      try {
        const raw = await client.executeCommand({
          name: command.name,
          ...(command.input === undefined ? {} : { input: command.input }),
        });
        return { command, raw, error: null as string | null };
      } catch (error) {
        return { command, raw: undefined, error: errorMessage(error) };
      }
    }));

    if (disposed || round !== generation) {
      return;
    }

    for (const item of results) {
      const host = hosts.get(item.command.name);
      if (!host) {
        continue;
      }
      if (item.error !== null) {
        renderSection(host, "error", item.error);
        continue;
      }
      if (item.command.name === POOL_BATCH) {
        renderPool(host, item.raw);
        continue;
      }
      const value = parseJson(item.raw);
      if (Array.isArray(value) && value.length === 0) {
        renderSection(host, "empty", "本环境不提供该数据");
      } else if (Array.isArray(value)) {
        renderSection(host, "ready", "", listTable(value.filter(isRecord), item.command.title));
      } else if (isRecord(value) && Object.keys(value).length > 0) {
        renderSection(host, "ready", "", jsonBlock(value));
      } else {
        renderSection(host, "empty", "本环境不提供该数据");
      }
    }

    const hot = results.find((item) => item.command.name === HOT_STOCKS);
    const codes = hot && hot.error === null ? stockCodes(hot.raw) : [];
    if (codes.length === 0) {
      renderSection(detailHost, "skipped", "热股榜没有可用 6 位股票代码，未发决策摘要查询");
      return;
    }
    try {
      const raw = await client.executeCommand({
        name: LATEST_ANALYSES,
        input: { stockCodes: codes },
      });
      if (disposed || round !== generation) {
        return;
      }
      const value = parseJson(raw);
      const rows = Array.isArray(value) ? value.filter(isRecord) : [];
      if (rows.length === 0) {
        renderSection(detailHost, "empty", "未查到这些股票的最近分析");
      } else {
        renderSection(detailHost, "ready", "", listTable(rows, "最近决策摘要", 5));
      }
    } catch (error) {
      if (disposed || round !== generation) {
        return;
      }
      renderSection(detailHost, "error", errorMessage(error));
    }
  }

  const onClick = (): void => {
    void refreshData();
  };
  refresh.addEventListener("click", onClick);
  void refreshData();

  return () => {
    disposed = true;
    ++generation;
    refresh.removeEventListener("click", onClick);
  };
}
