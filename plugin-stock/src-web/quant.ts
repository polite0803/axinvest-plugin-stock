// SPDX-License-Identifier: AGPL-3.0-only
//
// T3 原生 bundle 视图：量化实验室（只读数据面）。
//
// 三条命令均已在 plugin-stock worker 声明；宿主 `quant_backtest.rs` 的 core 只是
// `stock.analysis` 接缝的另一侧实现，本模块只经桥发命令，不直调宿主 IPC。
// `quant_backtest_run` 尚未在插件声明，故本视图不提供「发起回测」，避免半迁移。
//
// ⚠ 输入纪律：runId / runIds 为空时不发命令、不传空串（空 id 精确查询恒不命中，
// 会被 UI 误读成「无数据」）。显式显示「请填写…」与真实空态分开。

import type { AxAgentPluginClient } from "../vendor/sdk/pluginClientBridge";

const STRATEGIES = "stock_quant_strategies_list";
const RUN_GET = "stock_quant_run_get";
const METRICS_COMPARE = "stock_quant_metrics_compare";

interface StrategyRow {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
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

function text(value: unknown): string {
  return typeof value === "string" && value !== "" ? value : "—";
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
    const label: Record<typeof state, string> = {
      loading: "取数中…",
      error: `调用失败：${detail}`,
      empty: detail,
      skipped: detail,
      ready: detail,
    };
    p.textContent = label[state];
    section.appendChild(p);
  }
  host.appendChild(section);
}

function strategyTable(rows: readonly StrategyRow[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "p-table-wrap";
  const table = document.createElement("table");
  table.className = "p-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["策略名称", "版本", "说明", "ID"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  table.appendChild(head);
  const body = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const value of [text(row.name), text(row.version), text(row.description), text(row.id)]) {
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

function jsonBlock(value: unknown): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "x-json";
  pre.textContent = JSON.stringify(value, null, 2);
  return pre;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

/**
 * 装载量化页：策略列表默认加载；运行详情与指标对比按用户输入的 id 显式查询。
 * 每个区各自维护轮次，连续输入只让最后一次回包上屏。
 */
export function mountQuant(root: HTMLElement, client: AxAgentPluginClient): () => void {
  const bar = document.createElement("div");
  bar.className = "x-form";

  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "刷新策略";
  bar.appendChild(reload);

  const runLabel = document.createElement("label");
  runLabel.textContent = "运行 ID";
  const runInput = document.createElement("input");
  runInput.type = "text";
  runLabel.appendChild(runInput);
  bar.appendChild(runLabel);

  const runButton = document.createElement("button");
  runButton.type = "button";
  runButton.textContent = "查运行详情";
  bar.appendChild(runButton);

  const compareLabel = document.createElement("label");
  compareLabel.textContent = "对比 ID（逗号分隔）";
  const compareInput = document.createElement("input");
  compareInput.type = "text";
  compareLabel.appendChild(compareInput);
  bar.appendChild(compareLabel);

  const compareButton = document.createElement("button");
  compareButton.type = "button";
  compareButton.textContent = "对比指标";
  bar.appendChild(compareButton);

  const grid = document.createElement("div");
  grid.className = "x-grid";
  const strategyHost = document.createElement("div");
  const runHost = document.createElement("div");
  const compareHost = document.createElement("div");
  grid.append(strategyHost, runHost, compareHost);
  root.replaceChildren(bar, grid);

  let disposed = false;
  let strategyRound = 0;
  let runRound = 0;
  let compareRound = 0;

  async function loadStrategies(): Promise<void> {
    const round = ++strategyRound;
    renderSection(strategyHost, "loading", "");
    try {
      const value = parseJson(await client.executeCommand({ name: STRATEGIES }));
      if (disposed || round !== strategyRound) {
        return;
      }
      if (!Array.isArray(value)) {
        renderSection(strategyHost, "empty", "本环境不提供该数据");
        return;
      }
      if (value.length === 0) {
        renderSection(strategyHost, "empty", "暂无量化策略");
        return;
      }
      const rows = value.filter(isRecord) as StrategyRow[];
      const content = document.createElement("div");
      content.className = "q-strategies";
      const title = document.createElement("h3");
      title.textContent = `策略列表（${rows.length}）`;
      content.appendChild(title);
      content.appendChild(strategyTable(rows));
      renderSection(strategyHost, "ready", "", content);
    } catch (error) {
      if (disposed || round !== strategyRound) {
        return;
      }
      renderSection(strategyHost, "error", errorMessage(error));
    }
  }

  async function loadRun(): Promise<void> {
    const runId = runInput.value.trim();
    if (!runId) {
      renderSection(runHost, "skipped", "请填写运行 ID 后再查询（未发调用）");
      return;
    }
    const round = ++runRound;
    renderSection(runHost, "loading", "");
    try {
      const value = parseJson(await client.executeCommand({ name: RUN_GET, input: { runId } }));
      if (disposed || round !== runRound) {
        return;
      }
      if (!isRecord(value) || Object.keys(value).length === 0) {
        renderSection(runHost, "empty", "未找到该运行记录");
        return;
      }
      const content = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = `运行详情：${runId}`;
      content.appendChild(title);
      content.appendChild(jsonBlock(value));
      renderSection(runHost, "ready", "", content);
    } catch (error) {
      if (disposed || round !== runRound) {
        return;
      }
      renderSection(runHost, "error", errorMessage(error));
    }
  }

  async function loadCompare(): Promise<void> {
    const runIds = compareInput.value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    if (runIds.length === 0) {
      renderSection(compareHost, "skipped", "请填写至少一个运行 ID（未发调用）");
      return;
    }
    const round = ++compareRound;
    renderSection(compareHost, "loading", "");
    try {
      const value = parseJson(await client.executeCommand({ name: METRICS_COMPARE, input: { runIds } }));
      if (disposed || round !== compareRound) {
        return;
      }
      if (!isRecord(value) || Object.keys(value).length === 0) {
        renderSection(compareHost, "empty", "没有可对比的指标");
        return;
      }
      const content = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = `指标对比（${runIds.length} 个运行）`;
      content.appendChild(title);
      content.appendChild(jsonBlock(value));
      renderSection(compareHost, "ready", "", content);
    } catch (error) {
      if (disposed || round !== compareRound) {
        return;
      }
      renderSection(compareHost, "error", errorMessage(error));
    }
  }

  const onReload = (): void => { void loadStrategies(); };
  const onRun = (): void => { void loadRun(); };
  const onCompare = (): void => { void loadCompare(); };
  reload.addEventListener("click", onReload);
  runButton.addEventListener("click", onRun);
  compareButton.addEventListener("click", onCompare);

  // 空 id 的两区先渲染显式跳过态，不发任何命令。
  renderSection(runHost, "skipped", "请填写运行 ID 后再查询（未发调用）");
  renderSection(compareHost, "skipped", "请填写至少一个运行 ID（未发调用）");
  void loadStrategies();

  return () => {
    disposed = true;
    ++strategyRound;
    ++runRound;
    ++compareRound;
    reload.removeEventListener("click", onReload);
    runButton.removeEventListener("click", onRun);
    compareButton.removeEventListener("click", onCompare);
  };
}
