// SPDX-License-Identifier: AGPL-3.0-only
//
// T3 原生 bundle 视图：股票工作区（六视图命令台）。
//
// 宿主 `StockWorkspaceShell` 的六个视图各自依赖 React store 与大量组件；bundle 里
// 不复制那套 UI，而是把每个视图的**数据面**映射到已声明的只读命名命令：
//   分析 quote+financials / 监控 portfolio+alerts / 交易 positions+trades /
//   回测 recent / 对比 analyses→detail 级联 / 复盘 reflections。
// 所有命令经 `plugin_execute_command` 发给插件 worker，再走宿主对应接缝；
// 股票代码由用户输入，空值时零帧发出（不把空串当默认股票）。

import type { AxAgentPluginClient } from "../vendor/sdk/pluginClientBridge";

type ViewId = "analysis" | "monitor" | "trade" | "backtest" | "compare" | "review";

interface StockCall {
  name: string;
  input?: Record<string, unknown>;
}

const VIEWS: readonly (readonly [ViewId, string])[] = [
  ["analysis", "分析"],
  ["monitor", "监控"],
  ["trade", "交易"],
  ["backtest", "回测"],
  ["compare", "对比"],
  ["review", "复盘"],
];

const EMPTY_TEXT = "本环境不提供该数据";

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

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

/** 视图 → 一轮命令。入参只使用用户输入的 stockCode 与固定分页上限。 */
function callsFor(view: ViewId, stockCode: string): readonly StockCall[] {
  switch (view) {
    case "analysis":
      return [
        { name: "stock_get_quote", input: { stockCode } },
        { name: "stock_get_financials", input: { stockCode } },
      ];
    case "monitor":
      return [
        { name: "stock_list_portfolio" },
        { name: "stock_list_price_alerts" },
      ];
    case "trade":
      return [
        { name: "stock_get_trade_positions" },
        { name: "stock_list_trades", input: { stockCode, limit: 50 } },
      ];
    case "backtest":
      return [{ name: "stock_get_recent_analyses", input: { limit: 5 } }];
    case "compare":
      return [{ name: "stock_list_stock_analyses", input: { limit: 5, offset: 0 } }];
    case "review":
      return [{ name: "stock_list_reflections", input: { stockCode, limit: 10 } }];
  }
}

/** 对比视图的级联 id：从分析列表回执中取，取不到就渲染跳过态，不发空串。 */
function firstAnalysisId(raw: unknown): string | null {
  const value = parseJson(raw);
  const rows = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.rows) ? value.rows : [];
  for (const row of rows) {
    if (isRecord(row)) {
      for (const key of ["id", "analysisId"]) {
        const id = row[key];
        if (typeof id === "string" && id !== "") {
          return id;
        }
      }
    }
  }
  return null;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length === 0;
  }
  return false;
}

function renderOutcome(host: HTMLElement, call: StockCall, outcome: { kind: "ok"; raw: unknown } | { kind: "error"; message: string } | { kind: "skipped"; reason: string }): void {
  const section = document.createElement("section");
  section.className = "x-section";
  const title = document.createElement("h3");
  title.textContent = call.name;
  section.appendChild(title);
  const pre = document.createElement("pre");
  pre.className = "x-json";
  if (outcome.kind === "error") {
    pre.textContent = `调用失败：${outcome.message}`;
  } else if (outcome.kind === "skipped") {
    pre.textContent = `未发调用：${outcome.reason}`;
  } else {
    const value = parseJson(outcome.raw);
    pre.textContent = isEmpty(value) ? EMPTY_TEXT : JSON.stringify(value, null, 2);
  }
  section.appendChild(pre);
  host.appendChild(section);
}

async function invokeOne(client: AxAgentPluginClient, call: StockCall): Promise<{ kind: "ok"; raw: unknown } | { kind: "error"; message: string }> {
  try {
    const raw = await client.executeCommand(call.input === undefined ? { name: call.name } : { name: call.name, input: call.input });
    return { kind: "ok", raw };
  } catch (error) {
    return { kind: "error", message: errorMessage(error) };
  }
}

/**
 * 装载工作区页：六个视图按首次点击装载，切走只隐藏 DOM；
 * 每次装载独立 generation，过期回包不写宿主节点。
 */
export function mountWorkspace(root: HTMLElement, client: AxAgentPluginClient): () => void {
  const bar = document.createElement("div");
  bar.className = "x-form";
  const codeInput = document.createElement("input");
  codeInput.type = "text";
  codeInput.placeholder = "股票代码";
  codeInput.value = "600519";
  const hint = document.createElement("span");
  hint.className = "x-empty";
  hint.textContent = "空代码不发调用";
  bar.append(codeInput, hint);

  const nav = document.createElement("nav");
  nav.className = "stock-tabs w-tabs";
  const views = new Map<ViewId, HTMLElement>();
  const loaded = new Set<ViewId>();
  const generations = new Map<ViewId, number>();
  const buttons = new Map<ViewId, HTMLButtonElement>();

  for (const [id, label] of VIEWS) {
    const host = document.createElement("div");
    host.className = "stock-view w-view";
    host.hidden = true;
    views.set(id, host);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => activate(id));
    buttons.set(id, button);
    nav.appendChild(button);
  }
  root.replaceChildren(bar, nav, ...VIEWS.map(([id]) => views.get(id) as HTMLElement));

  let disposed = false;
  let active: ViewId = "analysis";

  async function load(view: ViewId): Promise<void> {
    const host = views.get(view);
    if (!host || disposed) {
      return;
    }
    const round = (generations.get(view) ?? 0) + 1;
    generations.set(view, round);
    host.replaceChildren();
    const stockCode = codeInput.value.trim();
    if (stockCode === "") {
      renderOutcome(host, { name: "本视图" }, { kind: "skipped", reason: "股票代码为空，未发调用" });
      return;
    }

    for (const call of callsFor(view, stockCode)) {
      const outcome = await invokeOne(client, call);
      if (disposed || generations.get(view) !== round) {
        return;
      }
      renderOutcome(host, call, outcome);
      if (view === "compare" && call.name === "stock_list_stock_analyses" && outcome.kind === "ok") {
        const analysisId = firstAnalysisId(outcome.raw);
        const detailCall: StockCall = { name: "stock_get_stock_analysis", input: { analysisId: analysisId ?? "" } };
        if (analysisId === null) {
          renderOutcome(host, detailCall, { kind: "skipped", reason: "分析列表无可用的 analysisId，未发调用" });
        } else {
          const detail = await invokeOne(client, detailCall);
          if (disposed || generations.get(view) !== round) {
            return;
          }
          renderOutcome(host, detailCall, detail);
        }
      }
    }
  }

  function activate(id: ViewId): void {
    active = id;
    for (const [viewId, button] of buttons) {
      button.setAttribute("aria-selected", String(viewId === id));
      const host = views.get(viewId);
      if (host) {
        host.hidden = viewId !== id;
      }
    }
    if (!loaded.has(id)) {
      loaded.add(id);
      void load(id);
    }
  }

  const onCodeChange = (): void => {
    // 代码变化只让当前视图重拉，其它视图等各自下次点开（不重复发帧）。
    void load(active);
  };
  codeInput.addEventListener("change", onCodeChange);
  activate(active);

  return () => {
    disposed = true;
    for (const round of generations.keys()) {
      generations.set(round, (generations.get(round) ?? 0) + 1);
    }
    codeInput.removeEventListener("change", onCodeChange);
  };
}
