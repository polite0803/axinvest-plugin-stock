// SPDX-License-Identifier: AGPL-3.0-only
//
// T3 原生 bundle 视图：模拟组合账本。
//
// 九条 `paper_portfolio_*` 命名命令已在 stock 插件清单声明，业务体经 `stock.analysis`
// 接缝落到宿主 analysis-engine；本模块只做取数、级联与最小交互，不重写组合/持仓算法。
// 入参纪律：detail / archive 的 portfolioId 只从真实回执的 id 取，取不到就渲染
// 「未发调用」提示，绝不发空串占位（宿主按 id 精确查库，空串只会伪装成空态）。

import type { AxAgentPluginClient } from "../vendor/sdk/pluginClientBridge";

const LIST_ACTIVE = "paper_portfolio_list_active_details";
const GET = "paper_portfolio_get";
const CREATE = "paper_portfolio_create";
const ARCHIVE = "paper_portfolio_archive";

interface Portfolio {
  id?: string;
  name?: string;
  sourceEvent?: string;
  status?: string;
  createdAt?: number;
  positions?: readonly unknown[];
  summary?: Record<string, unknown>;
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

function numberText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—";
}

/** loading / error / empty / ready 四态分列，不互相覆盖。 */
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

/** 单条组合：名称与来源事件来自回执，按钮只携带真实 id。 */
function portfolioRow(row: Portfolio, onDetail: (id: string) => void, onArchive: (id: string) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "l-row";
  const summary = isRecord(row.summary) ? row.summary : {};
  const labels = [
    `名称：${text(row.name)}`,
    `来源：${text(row.sourceEvent)}`,
    `状态：${text(row.status)}`,
    `持仓：${Array.isArray(row.positions) ? row.positions.length : "—"}`,
    `总市值：${numberText(summary.totalMarketValue)}`,
    `浮动盈亏：${numberText(summary.totalUnrealizedPnl)}`,
  ];
  for (const label of labels) {
    const span = document.createElement("span");
    span.textContent = label;
    wrap.appendChild(span);
  }
  const id = typeof row.id === "string" && row.id !== "" ? row.id : null;
  if (id === null) {
    const hint = document.createElement("span");
    hint.className = "x-empty";
    hint.textContent = "回执缺 id，未发详情/归档调用";
    wrap.appendChild(hint);
    return wrap;
  }
  const detail = document.createElement("button");
  detail.type = "button";
  detail.textContent = "组合详情";
  detail.addEventListener("click", () => onDetail(id));
  const archive = document.createElement("button");
  archive.type = "button";
  archive.textContent = "归档组合";
  archive.addEventListener("click", () => onArchive(id));
  wrap.append(detail, archive);
  return wrap;
}

/** 详情区：持仓表只消费真实回执字段，缺失值显示破折号。 */
function detailContent(raw: unknown): HTMLElement {
  const value = parseJson(raw);
  const wrap = document.createElement("div");
  wrap.className = "l-detail";
  if (!isRecord(value)) {
    const p = document.createElement("p");
    p.className = "x-empty";
    p.textContent = "本环境不提供该数据";
    wrap.appendChild(p);
    return wrap;
  }
  const positions = Array.isArray(value.positions) ? value.positions : [];
  const title = document.createElement("h3");
  title.textContent = `持仓明细（${positions.length}）`;
  wrap.appendChild(title);
  if (positions.length === 0) {
    const p = document.createElement("p");
    p.className = "x-empty";
    p.textContent = "暂无持仓";
    wrap.appendChild(p);
    return wrap;
  }
  const table = document.createElement("table");
  table.className = "p-table";
  for (const row of positions) {
    const tr = document.createElement("tr");
    if (!isRecord(row)) {
      continue;
    }
    for (const key of ["symbol", "quantity", "entryPrice", "currentPrice", "unrealizedPnl"]) {
      const td = document.createElement("td");
      td.textContent = key === "symbol" ? text(row[key]) : numberText(row[key]);
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  wrap.appendChild(table);
  return wrap;
}

/**
 * 装载模拟组合账本页：默认读 active 详情，创建/详情/归档显式发帧。
 * generation 保证连续刷新只有最后一轮回包上屏；卸载后回调不碰宿主节点。
 */
export function mountPaperLedger(root: HTMLElement, client: AxAgentPluginClient): () => void {
  const bar = document.createElement("div");
  bar.className = "x-form";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "组合名称";
  const eventInput = document.createElement("input");
  eventInput.type = "text";
  eventInput.placeholder = "来源事件";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "刷新组合";
  const create = document.createElement("button");
  create.type = "button";
  create.textContent = "创建组合";
  bar.append(nameInput, eventInput, refresh, create);

  const listHost = document.createElement("div");
  listHost.className = "l-host";
  const detailHost = document.createElement("div");
  detailHost.className = "l-host";
  root.replaceChildren(bar, listHost, detailHost);

  let disposed = false;
  let generation = 0;

  async function load(): Promise<void> {
    const round = ++generation;
    renderSection(listHost, "loading", "");
    try {
      const raw = await client.executeCommand({ name: LIST_ACTIVE });
      if (disposed || round !== generation) {
        return;
      }
      const value = parseJson(raw);
      if (!Array.isArray(value) || value.length === 0) {
        renderSection(listHost, "empty", "暂无模拟组合");
        return;
      }
      const content = document.createElement("div");
      for (const row of value) {
        if (!isRecord(row)) {
          continue;
        }
        content.appendChild(portfolioRow(row as Portfolio, voidDetail, voidArchive));
      }
      renderSection(listHost, "ready", "", content);
    } catch (error) {
      if (disposed || round !== generation) {
        return;
      }
      renderSection(listHost, "error", errorMessage(error));
    }
  }

  async function callWithId(name: string, id: string, target: HTMLElement): Promise<void> {
    if (disposed || id === "") {
      return;
    }
    const round = ++generation;
    renderSection(target, "loading", "");
    try {
      const raw = await client.executeCommand({ name, input: { portfolioId: id } });
      if (disposed || round !== generation) {
        return;
      }
      if (name === GET) {
        renderSection(target, "ready", "", detailContent(raw));
      } else {
        await load();
      }
    } catch (error) {
      if (disposed || round !== generation) {
        return;
      }
      renderSection(target, "error", errorMessage(error));
    }
  }

  const voidDetail = (id: string): void => {
    void callWithId(GET, id, detailHost);
  };
  const voidArchive = (id: string): void => {
    void callWithId(ARCHIVE, id, listHost);
  };

  const onRefresh = (): void => {
    void load();
  };
  const onCreate = (): void => {
    const name = nameInput.value.trim();
    const sourceEvent = eventInput.value.trim();
    if (name === "" || sourceEvent === "") {
      renderSection(detailHost, "empty", "未发调用：请填写组合名称与来源事件");
      return;
    }
    // 创建命令的入参是 name/sourceEvent，不是 portfolioId，单独发帧。
    void onCreateRequest(name, sourceEvent);
  };

  async function onCreateRequest(name: string, sourceEvent: string): Promise<void> {
    const round = ++generation;
    renderSection(detailHost, "loading", "");
    try {
      const raw = await client.executeCommand({ name: CREATE, input: { name, sourceEvent } });
      if (disposed || round !== generation) {
        return;
      }
      renderSection(detailHost, "ready", "", detailContent(raw));
      nameInput.value = "";
      eventInput.value = "";
      await load();
    } catch (error) {
      if (disposed || round !== generation) {
        return;
      }
      renderSection(detailHost, "error", errorMessage(error));
    }
  }

  refresh.addEventListener("click", onRefresh);
  create.addEventListener("click", onCreate);
  void load();

  return () => {
    disposed = true;
    ++generation;
    refresh.removeEventListener("click", onRefresh);
    create.removeEventListener("click", onCreate);
  };
}

