// SPDX-License-Identifier: AGPL-3.0-only
//
// T3 首个垂直切片：跨市场行情页（原生 TS/IIFE，不依赖宿主 React / store / i18n）。
//
// 入参 / 出参形状对齐宿主 `src/stores/feature/crossMarketStore.ts`（只作契约参考，不 import）：
// 四条命令都已在 plugin-stock worker 声明，bundle 侧统一经 `client.executeCommand()` 投递，
// 不能直调宿主 IPC（vendored 桥白名单只有 plugin_execute_command / plugin_ui_action）。
//
// ⚠ 本模块不发 `announceReady()` / `dispose()`：它们属于页面生命周期，留在入口 main.ts
// 顶层唯一一处，避免多页共存时发两帧 ready 或重复解绑。

import type { AxAgentPluginClient } from "../vendor/sdk/pluginClientBridge";

const DEFAULT_PERIOD = "daily";
const DEFAULT_LIMIT = 120;

/** 跨市场默认标的：与宿主 CrossMarketDashboard 的初始参数同档。 */
const DEFAULT_STOCK_CODE = "AAPL";
const DEFAULT_BENCHMARK = "SPX";
const DEFAULT_PAIR = "USD/JPY";

/** 输入表单的字段定义；键名即命令入参的 camelCase 名（禁区 13）。 */
interface MarketInput {
  stockCode: string;
  benchmarkCode: string;
  pair: string;
  period: string;
  limit: number;
}

const INPUTS: readonly { key: keyof MarketInput; label: string; type: "text" | "number" }[] = [
  { key: "stockCode", label: "国际股票代码", type: "text" },
  { key: "benchmarkCode", label: "基准指数代码", type: "text" },
  { key: "pair", label: "货币对", type: "text" },
  { key: "period", label: "周期", type: "text" },
  { key: "limit", label: "K 线根数", type: "number" },
];

function defaultInput(): MarketInput {
  return {
    stockCode: DEFAULT_STOCK_CODE,
    benchmarkCode: DEFAULT_BENCHMARK,
    pair: DEFAULT_PAIR,
    period: DEFAULT_PERIOD,
    limit: DEFAULT_LIMIT,
  };
}

/** 一段 K 线：仅取渲染所需字段，其余字段原样透传不做假设。 */
interface KLine {
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  [key: string]: unknown;
}

interface Quote {
  symbol?: string;
  name?: string;
  price?: number;
  change?: number;
  changePercent?: number;
  currency?: string;
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

function formatNumber(value: unknown, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
}

/** 人类可读的最小值：不把非数字字段伪装成 0。 */
function extractNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 渲染 K 线折线（收盘价）。无 SVG 依赖：按最小/最大值归一化到 viewBox，
 * 空数组返回明确的「暂无 K 线」文案，不画空图。
 */
function renderKline(host: HTMLElement, title: string, rows: readonly KLine[]): void {
  if (rows.length === 0) {
    renderSection(host, title, "ready", "暂无 K 线数据");
    return;
  }
  const closes = rows.map((row) => extractNumber(row.close));
  const valid = closes.filter((value): value is number => value !== null);
  if (valid.length === 0) {
    renderSection(host, title, "ready", "K 线缺少可用收盘价");
    return;
  }
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const span = max - min || 1;
  const step = rows.length > 1 ? 600 / (rows.length - 1) : 0;
  const points = closes
    .map((value, index) => {
      if (value === null) {
        return null;
      }
      const x = 20 + index * step;
      const y = 130 - ((value - min) / span) * 110;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .filter((point): point is string => point !== null)
    .join(" ");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 640 150");
  svg.setAttribute("class", "x-chart");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  path.setAttribute("points", points);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  svg.appendChild(path);
  const content = document.createElement("div");
  content.append(svg);
  const range = document.createElement("p");
  range.className = "x-range";
  range.textContent = `区间 ${formatNumber(min)} — ${formatNumber(max)} · ${rows.length} 根`;
  content.appendChild(range);
  renderSection(host, title, "ready", "", content);
}

/** 调用一条命令并解析 JSON 文本回执；失败收敛为 error，不吞错成空态。 */
async function call<T>(
  client: AxAgentPluginClient,
  name: string,
  input: Record<string, unknown>,
): Promise<T> {
  const raw = await client.executeCommand({ name, input });
  return parseJson(raw) as T;
}

/** 一个取数区：loading / error / empty / 数据四态分列，区之间互不覆盖。 */
function renderSection(
  host: HTMLElement,
  title: string,
  state: "loading" | "error" | "ready",
  detail: string,
  content?: HTMLElement,
): void {
  const section = document.createElement("section");
  section.className = "x-section";
  const h3 = document.createElement("h3");
  h3.textContent = title;
  section.appendChild(h3);
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
  } else if (content) {
    section.appendChild(content);
  } else {
    const p = document.createElement("p");
    p.className = "x-empty";
    p.textContent = detail;
    section.appendChild(p);
  }
  host.replaceChildren(section);
}

function renderQuote(host: HTMLElement, quote: Quote): void {
  if (!isRecord(quote as unknown) || Object.keys(quote).length === 0) {
    renderSection(host, "国际股票行情", "ready", "本环境不提供该数据");
    return;
  }
  const content = document.createElement("div");
  content.className = "x-kv";
  const pairs: readonly (readonly [string, unknown])[] = [
    ["代码", quote.symbol],
    ["名称", quote.name],
    ["现价", formatNumber(quote.price)],
    ["涨跌", formatNumber(quote.change)],
    ["涨跌幅", quote.changePercent === undefined ? "—" : `${formatNumber(quote.changePercent)}%`],
    ["币种", quote.currency],
  ];
  for (const [label, value] of pairs) {
    const row = document.createElement("div");
    const key = document.createElement("span");
    key.textContent = label;
    const val = document.createElement("strong");
    val.textContent = typeof value === "string" || typeof value === "number" ? String(value) : "—";
    row.append(key, val);
    content.appendChild(row);
  }
  renderSection(host, "国际股票行情", "ready", "", content);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return JSON.stringify(error);
}

/**
 * 装载跨市场页：宿主只给一个容器，输入态留在组件内部（不写 URL / store）。
 * 四个取数区并发发起、各自独立失败，任一区失败不遮住其它区。
 */
export function mountCrossMarket(root: HTMLElement, client: AxAgentPluginClient): () => void {
  const input = defaultInput();
  const controls: Partial<Record<keyof MarketInput, HTMLInputElement>> = {};

  const form = document.createElement("div");
  form.className = "x-form";
  for (const field of INPUTS) {
    const label = document.createElement("label");
    label.textContent = field.label;
    const fieldInput = document.createElement("input");
    fieldInput.type = field.type;
    fieldInput.value = String(input[field.key]);
    if (field.type === "number") {
      fieldInput.min = "1";
    }
    label.appendChild(fieldInput);
    form.appendChild(label);
    controls[field.key] = fieldInput;
  }
  const run = document.createElement("button");
  run.type = "button";
  run.textContent = "刷新行情";
  form.appendChild(run);

  const grid = document.createElement("div");
  grid.className = "x-grid";
  const quoteHost = document.createElement("div");
  const intlKlineHost = document.createElement("div");
  const benchmarkHost = document.createElement("div");
  const forexHost = document.createElement("div");
  grid.append(quoteHost, intlKlineHost, benchmarkHost, forexHost);

  root.replaceChildren(form, grid);

  let disposed = false;
  let generation = 0;
  const readInput = (): MarketInput => ({
    stockCode: controls.stockCode?.value.trim() || DEFAULT_STOCK_CODE,
    benchmarkCode: controls.benchmarkCode?.value.trim() || DEFAULT_BENCHMARK,
    pair: controls.pair?.value.trim() || DEFAULT_PAIR,
    period: controls.period?.value.trim() || DEFAULT_PERIOD,
    limit: Math.max(1, Number(controls.limit?.value) || DEFAULT_LIMIT),
  });

  async function refresh(): Promise<void> {
    const round = ++generation;
    const params = readInput();
    const klineInput = { period: params.period, limit: params.limit };
    renderSection(quoteHost, "国际股票行情", "loading", "");
    renderSection(intlKlineHost, "国际股票 K 线", "loading", "");
    renderSection(benchmarkHost, "基准指数 K 线", "loading", "");
    renderSection(forexHost, "外汇 K 线", "loading", "");

    const tasks = [
      {
        host: quoteHost,
        title: "国际股票行情",
        run: async () => renderQuote(
          quoteHost,
          await call<Quote>(client, "stock_get_international_stock_quote", {
            stockCode: params.stockCode,
          }),
        ),
      },
      {
        host: intlKlineHost,
        title: "国际股票 K 线",
        run: async () => renderKline(
          intlKlineHost,
          "国际股票 K 线",
          (await call<KLine[]>(client, "stock_get_international_stock_kline", {
            stockCode: params.stockCode,
            ...klineInput,
          })) ?? [],
        ),
      },
      {
        host: benchmarkHost,
        title: "基准指数 K 线",
        run: async () => renderKline(
          benchmarkHost,
          "基准指数 K 线",
          (await call<KLine[]>(client, "stock_get_benchmark_kline", {
            benchmarkCode: params.benchmarkCode,
            ...klineInput,
          })) ?? [],
        ),
      },
      {
        host: forexHost,
        title: "外汇 K 线",
        run: async () => renderKline(
          forexHost,
          "外汇 K 线",
          (await call<KLine[]>(client, "stock_get_forex_kline", {
            pair: params.pair,
            ...klineInput,
          })) ?? [],
        ),
      },
    ];
    for (const task of tasks) {
      void (async () => {
        try {
          await task.run();
        } catch (error) {
          renderSection(task.host, task.title, "error", errorMessage(error));
        }
        // 过期轮次的回包不重绘：连续点击刷新时只让最后一次生效。
        // 注意不能清空宿主节点 —— 那会把刚发布的成功视图抹掉。
        if (disposed || round !== generation) {
          return;
        }
      })();
    }
  }

  const onClick = (): void => {
    void refresh();
  };
  run.addEventListener("click", onClick);
  void refresh();

  return () => {
    disposed = true;
    ++generation;
    run.removeEventListener("click", onClick);
  };
}
