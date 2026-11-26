"use strict";
(() => {
  // vendor/sdk/sandboxFrameProtocol.ts
  var SANDBOX_FRAME_TYPES = {
    /** 沙箱 → 宿主：一次 RPC 请求 */
    request: "rpc:request",
    /** 宿主 → 沙箱：一次 RPC 的响应（成功或失败共用这一帧） */
    response: "rpc:response",
    /** 沙箱 → 宿主：内容已就绪，宿主可以开始接它的请求 */
    ready: "skill:ready",
    /** 沙箱 → 宿主：内容内部报错（运行期异常 / 未捕获拒绝） */
    contentError: "skill:error",
    /** 宿主 → 沙箱：事件推送 */
    hostEvent: "host:event",
    /** 宿主 → 沙箱：生命周期（挂载 / 卸载） */
    hostLifecycle: "host:lifecycle"
  };
  var SANDBOX_RPC_METHODS = {
    apiInvoke: "api.invoke",
    apiEmit: "api.emit",
    uiNavigate: "ui.navigate",
    uiNotify: "ui.notify",
    uiGetTheme: "ui.getTheme",
    uiGetLocale: "ui.getLocale",
    storeRead: "store.read",
    storeWrite: "store.write"
  };
  var SANDBOX_FRAME_FIELDS = {
    type: "type",
    callId: "callId",
    method: "method",
    args: "args",
    result: "result",
    error: "error",
    event: "event",
    payload: "payload",
    phase: "phase",
    props: "props",
    source: "source",
    line: "line",
    col: "col"
  };
  var SANDBOX_RPC_ARG_KEYS = {
    command: "command",
    args: "args",
    event: "event",
    payload: "payload",
    path: "path",
    message: "message",
    type: "type",
    storeName: "storeName",
    selector: "selector",
    value: "value"
  };
  var SANDBOX_RPC_TIMEOUT_MS = 15e3;
  var SANDBOX_RPC_FAILURE_ERROR_TYPE = "string";
  var SANDBOX_MESSAGE_TARGET_ORIGIN = "*";
  var SANDBOX_CALL_ID_PREFIX = {
    /** 宿主向沙箱发起调用（`callSkillMethod`） */
    host: "host_",
    /** `srcdoc` 沙箱内容（Skill 与插件 panel）向宿主发起 RPC */
    sandbox: "skill_",
    /** 走 asset 协议装载的插件 bundle（page 粒度）向宿主发起 RPC */
    plugin: "plugin_"
  };
  function buildRpcRequestFrame(callId, method, args) {
    const f = SANDBOX_FRAME_FIELDS;
    const frame = {
      [f.type]: SANDBOX_FRAME_TYPES.request,
      [f.callId]: callId,
      [f.method]: method
    };
    if (args !== void 0) {
      frame[f.args] = args;
    }
    return frame;
  }
  function buildSandboxReadyFrame() {
    return { [SANDBOX_FRAME_FIELDS.type]: SANDBOX_FRAME_TYPES.ready };
  }
  function formatCallId(prefix, sequence) {
    return `${prefix}${sequence}_${Date.now()}`;
  }
  function frameTypeOf(data) {
    if (!data || typeof data !== "object") {
      return void 0;
    }
    const value = data[SANDBOX_FRAME_FIELDS.type];
    return typeof value === "string" ? value : void 0;
  }
  function isRpcResponseFrame(data) {
    return frameTypeOf(data) === SANDBOX_FRAME_TYPES.response;
  }
  function isFailureFrame(frame) {
    const raw = frame[SANDBOX_FRAME_FIELDS.error];
    return typeof raw === SANDBOX_RPC_FAILURE_ERROR_TYPE;
  }
  function readRpcResponseCallId(frame) {
    const raw = frame[SANDBOX_FRAME_FIELDS.callId];
    return typeof raw === "string" ? raw : void 0;
  }
  function isFrameFromSandboxSource(event, sandboxWindow) {
    if (sandboxWindow === null || sandboxWindow === void 0) {
      return false;
    }
    return event.source === sandboxWindow;
  }

  // vendor/sdk/pluginBridgeProtocol.ts
  var PLUGIN_BRIDGE_COMMAND_NAMES = {
    /** 动态 UI / 沙箱内容把用户动作回流给**该插件自己的** worker（后端 `plugin_ui_action`）。 */
    uiAction: "plugin_ui_action",
    /** 按名字调用该插件声明的命令（后端 `plugin_execute_command`）。 */
    executeCommand: "plugin_execute_command"
  };
  var PLUGIN_BRIDGE_COMMANDS = [
    PLUGIN_BRIDGE_COMMAND_NAMES.uiAction,
    PLUGIN_BRIDGE_COMMAND_NAMES.executeCommand
  ];
  function isPluginBridgeCommand(command) {
    return PLUGIN_BRIDGE_COMMANDS.includes(command);
  }
  var HOST_BOUND_PLUGIN_ID_FIELD = "pluginId";
  function omitHostBoundPluginId(args) {
    if (!args) {
      return {};
    }
    const { [HOST_BOUND_PLUGIN_ID_FIELD]: _ignored, ...rest } = args;
    return rest;
  }
  var PLUGIN_UI_ACTION_ARG_KEY = "action";
  var PLUGIN_BRIDGE_CLIENT_METHODS = [SANDBOX_RPC_METHODS.apiInvoke];

  // vendor/sdk/pluginClientBridge.ts
  function adaptParentWindow(parent) {
    return {
      postMessage: (message, targetOrigin) => {
        parent.postMessage(message, targetOrigin);
      }
    };
  }
  function adaptWindowSource(win) {
    return {
      addEventListener: (type, listener) => {
        win.addEventListener(type, listener);
      },
      removeEventListener: (type, listener) => {
        win.removeEventListener(type, listener);
      }
    };
  }
  function createAxAgentPluginClient(options = {}) {
    const globalWindow = typeof window === "undefined" ? void 0 : window;
    const rawTarget = options.postTarget ?? (globalWindow ? adaptParentWindow(globalWindow.parent) : void 0);
    const rawSource = options.messageSource ?? (globalWindow ? adaptWindowSource(globalWindow) : void 0);
    if (!rawTarget || !rawSource) {
      throw new Error(
        "createAxAgentPluginClient: \u9700\u8981\u6D4F\u89C8\u5668\u7A97\u53E3\u73AF\u5883\uFF08window.parent / window\uFF09\u6216\u663E\u5F0F\u6CE8\u5165 postTarget \u4E0E messageSource"
      );
    }
    const target = rawTarget;
    const source = rawSource;
    const targetOrigin = options.targetOrigin ?? SANDBOX_MESSAGE_TARGET_ORIGIN;
    const timeoutMs = options.timeoutMs ?? SANDBOX_RPC_TIMEOUT_MS;
    const hostWindow = options.hostWindow ?? (globalWindow ? globalWindow.parent : void 0);
    const pending = /* @__PURE__ */ new Map();
    let sequence = 0;
    let disposed = false;
    function handleMessage(event) {
      if (disposed) {
        return;
      }
      if (!isFrameFromSandboxSource({ data: event.data, source: event.source }, hostWindow)) {
        return;
      }
      const frame = event.data;
      if (!isRpcResponseFrame(frame)) {
        return;
      }
      const callId = readRpcResponseCallId(frame);
      if (!callId) {
        return;
      }
      const entry = pending.get(callId);
      if (!entry) {
        return;
      }
      clearTimeout(entry.timer);
      pending.delete(callId);
      if (isFailureFrame(frame)) {
        entry.reject(new Error(frame.error));
      } else {
        entry.resolve(frame.result);
      }
    }
    source.addEventListener("message", handleMessage);
    function request(command, args) {
      if (disposed) {
        return Promise.reject(new Error("\u63D2\u4EF6\u6865\u5BA2\u6237\u7AEF\u5DF2\u91CA\u653E\uFF08dispose \u540E\u4E0D\u53EF\u518D\u8C03\u7528\uFF09"));
      }
      const callId = formatCallId(SANDBOX_CALL_ID_PREFIX.plugin, ++sequence);
      const envelope = { [SANDBOX_RPC_ARG_KEYS.command]: command };
      if (args !== void 0) {
        envelope[SANDBOX_RPC_ARG_KEYS.args] = omitHostBoundPluginId(args);
      }
      const frame = buildRpcRequestFrame(
        callId,
        SANDBOX_RPC_METHODS.apiInvoke,
        envelope
      );
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(callId);
          reject(new Error(`\u63D2\u4EF6\u6865\u8C03\u7528\u300C${command}\u300D\u8D85\u65F6\uFF08${timeoutMs}ms \u672A\u6536\u5230\u5BBF\u4E3B\u54CD\u5E94\uFF09`));
        }, timeoutMs);
        pending.set(callId, { resolve, reject, timer });
        try {
          target.postMessage(frame, targetOrigin);
        } catch (error) {
          clearTimeout(timer);
          pending.delete(callId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }
    return {
      invoke: (command, args) => {
        if (!isPluginBridgeCommand(command)) {
          return Promise.reject(
            new Error(
              `\u63D2\u4EF6\u6865\u767D\u540D\u5355\u5916\u7684\u547D\u4EE4\u300C${String(command)}\u300D\uFF1A\u53EF\u7528\u6E05\u5355\u89C1 AX_AGENT_PLUGIN_BRIDGE_COMMANDS\uFF0C\u65B0\u589E\u901A\u9053\u9700\u6539 pluginBridgeProtocol.ts \u5E76\u7ECF\u5BBF\u4E3B\u4FA7\u8BC4\u5BA1`
            )
          );
        }
        return request(command, args);
      },
      uiAction: (action) => request(PLUGIN_BRIDGE_COMMAND_NAMES.uiAction, {
        [PLUGIN_UI_ACTION_ARG_KEY]: action
      }),
      executeCommand: (args) => request(PLUGIN_BRIDGE_COMMAND_NAMES.executeCommand, args),
      announceReady() {
        if (disposed) {
          return;
        }
        const frame = buildSandboxReadyFrame();
        try {
          target.postMessage(frame, targetOrigin);
        } catch {
        }
      },
      dispose() {
        disposed = true;
        source.removeEventListener("message", handleMessage);
        for (const entry of pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error("\u63D2\u4EF6\u6865\u5BA2\u6237\u7AEF\u5DF2\u91CA\u653E\uFF08dispose\uFF09"));
        }
        pending.clear();
      }
    };
  }

  // src-web/crossMarket.ts
  var DEFAULT_PERIOD = "daily";
  var DEFAULT_LIMIT = 120;
  var DEFAULT_STOCK_CODE = "AAPL";
  var DEFAULT_BENCHMARK = "SPX";
  var DEFAULT_PAIR = "USD/JPY";
  var INPUTS = [
    { key: "stockCode", label: "\u56FD\u9645\u80A1\u7968\u4EE3\u7801", type: "text" },
    { key: "benchmarkCode", label: "\u57FA\u51C6\u6307\u6570\u4EE3\u7801", type: "text" },
    { key: "pair", label: "\u8D27\u5E01\u5BF9", type: "text" },
    { key: "period", label: "\u5468\u671F", type: "text" },
    { key: "limit", label: "K \u7EBF\u6839\u6570", type: "number" }
  ];
  function defaultInput() {
    return {
      stockCode: DEFAULT_STOCK_CODE,
      benchmarkCode: DEFAULT_BENCHMARK,
      pair: DEFAULT_PAIR,
      period: DEFAULT_PERIOD,
      limit: DEFAULT_LIMIT
    };
  }
  function parseJson(raw) {
    if (typeof raw !== "string") {
      return raw;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function formatNumber(value, digits = 2) {
    return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "\u2014";
  }
  function extractNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  function renderKline(host, title, rows) {
    if (rows.length === 0) {
      renderSection(host, title, "ready", "\u6682\u65E0 K \u7EBF\u6570\u636E");
      return;
    }
    const closes = rows.map((row) => extractNumber(row.close));
    const valid = closes.filter((value) => value !== null);
    if (valid.length === 0) {
      renderSection(host, title, "ready", "K \u7EBF\u7F3A\u5C11\u53EF\u7528\u6536\u76D8\u4EF7");
      return;
    }
    const min = Math.min(...valid);
    const max = Math.max(...valid);
    const span = max - min || 1;
    const step = rows.length > 1 ? 600 / (rows.length - 1) : 0;
    const points = closes.map((value, index) => {
      if (value === null) {
        return null;
      }
      const x = 20 + index * step;
      const y = 130 - (value - min) / span * 110;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).filter((point) => point !== null).join(" ");
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
    range.textContent = `\u533A\u95F4 ${formatNumber(min)} \u2014 ${formatNumber(max)} \xB7 ${rows.length} \u6839`;
    content.appendChild(range);
    renderSection(host, title, "ready", "", content);
  }
  async function call(client2, name, input) {
    const raw = await client2.executeCommand({ name, input });
    return parseJson(raw);
  }
  function renderSection(host, title, state, detail, content) {
    const section = document.createElement("section");
    section.className = "x-section";
    const h3 = document.createElement("h3");
    h3.textContent = title;
    section.appendChild(h3);
    if (state === "loading") {
      const p = document.createElement("p");
      p.className = "x-empty";
      p.textContent = "\u53D6\u6570\u4E2D\u2026";
      section.appendChild(p);
    } else if (state === "error") {
      const p = document.createElement("p");
      p.className = "x-error";
      p.textContent = `\u8C03\u7528\u5931\u8D25\uFF1A${detail}`;
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
  function renderQuote(host, quote) {
    if (!isRecord(quote) || Object.keys(quote).length === 0) {
      renderSection(host, "\u56FD\u9645\u80A1\u7968\u884C\u60C5", "ready", "\u672C\u73AF\u5883\u4E0D\u63D0\u4F9B\u8BE5\u6570\u636E");
      return;
    }
    const content = document.createElement("div");
    content.className = "x-kv";
    const pairs = [
      ["\u4EE3\u7801", quote.symbol],
      ["\u540D\u79F0", quote.name],
      ["\u73B0\u4EF7", formatNumber(quote.price)],
      ["\u6DA8\u8DCC", formatNumber(quote.change)],
      ["\u6DA8\u8DCC\u5E45", quote.changePercent === void 0 ? "\u2014" : `${formatNumber(quote.changePercent)}%`],
      ["\u5E01\u79CD", quote.currency]
    ];
    for (const [label, value] of pairs) {
      const row = document.createElement("div");
      const key = document.createElement("span");
      key.textContent = label;
      const val = document.createElement("strong");
      val.textContent = typeof value === "string" || typeof value === "number" ? String(value) : "\u2014";
      row.append(key, val);
      content.appendChild(row);
    }
    renderSection(host, "\u56FD\u9645\u80A1\u7968\u884C\u60C5", "ready", "", content);
  }
  function errorMessage(error) {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "string") {
      return error;
    }
    return JSON.stringify(error);
  }
  function mountCrossMarket(root2, client2) {
    const input = defaultInput();
    const controls = {};
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
    run.textContent = "\u5237\u65B0\u884C\u60C5";
    form.appendChild(run);
    const grid = document.createElement("div");
    grid.className = "x-grid";
    const quoteHost = document.createElement("div");
    const intlKlineHost = document.createElement("div");
    const benchmarkHost = document.createElement("div");
    const forexHost = document.createElement("div");
    grid.append(quoteHost, intlKlineHost, benchmarkHost, forexHost);
    root2.replaceChildren(form, grid);
    let disposed = false;
    let generation = 0;
    const readInput = () => ({
      stockCode: controls.stockCode?.value.trim() || DEFAULT_STOCK_CODE,
      benchmarkCode: controls.benchmarkCode?.value.trim() || DEFAULT_BENCHMARK,
      pair: controls.pair?.value.trim() || DEFAULT_PAIR,
      period: controls.period?.value.trim() || DEFAULT_PERIOD,
      limit: Math.max(1, Number(controls.limit?.value) || DEFAULT_LIMIT)
    });
    async function refresh() {
      const round = ++generation;
      const params = readInput();
      const klineInput = { period: params.period, limit: params.limit };
      renderSection(quoteHost, "\u56FD\u9645\u80A1\u7968\u884C\u60C5", "loading", "");
      renderSection(intlKlineHost, "\u56FD\u9645\u80A1\u7968 K \u7EBF", "loading", "");
      renderSection(benchmarkHost, "\u57FA\u51C6\u6307\u6570 K \u7EBF", "loading", "");
      renderSection(forexHost, "\u5916\u6C47 K \u7EBF", "loading", "");
      const tasks = [
        {
          host: quoteHost,
          title: "\u56FD\u9645\u80A1\u7968\u884C\u60C5",
          run: async () => renderQuote(
            quoteHost,
            await call(client2, "stock_get_international_stock_quote", {
              stockCode: params.stockCode
            })
          )
        },
        {
          host: intlKlineHost,
          title: "\u56FD\u9645\u80A1\u7968 K \u7EBF",
          run: async () => renderKline(
            intlKlineHost,
            "\u56FD\u9645\u80A1\u7968 K \u7EBF",
            await call(client2, "stock_get_international_stock_kline", {
              stockCode: params.stockCode,
              ...klineInput
            }) ?? []
          )
        },
        {
          host: benchmarkHost,
          title: "\u57FA\u51C6\u6307\u6570 K \u7EBF",
          run: async () => renderKline(
            benchmarkHost,
            "\u57FA\u51C6\u6307\u6570 K \u7EBF",
            await call(client2, "stock_get_benchmark_kline", {
              benchmarkCode: params.benchmarkCode,
              ...klineInput
            }) ?? []
          )
        },
        {
          host: forexHost,
          title: "\u5916\u6C47 K \u7EBF",
          run: async () => renderKline(
            forexHost,
            "\u5916\u6C47 K \u7EBF",
            await call(client2, "stock_get_forex_kline", {
              pair: params.pair,
              ...klineInput
            }) ?? []
          )
        }
      ];
      for (const task of tasks) {
        void (async () => {
          try {
            await task.run();
          } catch (error) {
            renderSection(task.host, task.title, "error", errorMessage(error));
          }
          if (disposed || round !== generation) {
            return;
          }
        })();
      }
    }
    const onClick = () => {
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

  // src-web/paperLedger.ts
  var LIST_ACTIVE = "paper_portfolio_list_active_details";
  var GET = "paper_portfolio_get";
  var CREATE = "paper_portfolio_create";
  var ARCHIVE = "paper_portfolio_archive";
  function parseJson2(raw) {
    if (typeof raw !== "string") {
      return raw;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  function isRecord2(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function text(value) {
    return typeof value === "string" && value !== "" ? value : "\u2014";
  }
  function numberText(value) {
    return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "\u2014";
  }
  function renderSection2(host, state, detail, content) {
    host.replaceChildren();
    const section = document.createElement("section");
    section.className = "x-section";
    if (state === "loading") {
      const p = document.createElement("p");
      p.className = "x-empty";
      p.textContent = "\u53D6\u6570\u4E2D\u2026";
      section.appendChild(p);
    } else if (state === "error") {
      const p = document.createElement("p");
      p.className = "x-error";
      p.textContent = `\u8C03\u7528\u5931\u8D25\uFF1A${detail}`;
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
  function errorMessage2(error) {
    if (error instanceof Error) {
      return error.message;
    }
    return typeof error === "string" ? error : JSON.stringify(error);
  }
  function portfolioRow(row, onDetail, onArchive) {
    const wrap = document.createElement("div");
    wrap.className = "l-row";
    const summary = isRecord2(row.summary) ? row.summary : {};
    const labels = [
      `\u540D\u79F0\uFF1A${text(row.name)}`,
      `\u6765\u6E90\uFF1A${text(row.sourceEvent)}`,
      `\u72B6\u6001\uFF1A${text(row.status)}`,
      `\u6301\u4ED3\uFF1A${Array.isArray(row.positions) ? row.positions.length : "\u2014"}`,
      `\u603B\u5E02\u503C\uFF1A${numberText(summary.totalMarketValue)}`,
      `\u6D6E\u52A8\u76C8\u4E8F\uFF1A${numberText(summary.totalUnrealizedPnl)}`
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
      hint.textContent = "\u56DE\u6267\u7F3A id\uFF0C\u672A\u53D1\u8BE6\u60C5/\u5F52\u6863\u8C03\u7528";
      wrap.appendChild(hint);
      return wrap;
    }
    const detail = document.createElement("button");
    detail.type = "button";
    detail.textContent = "\u7EC4\u5408\u8BE6\u60C5";
    detail.addEventListener("click", () => onDetail(id));
    const archive = document.createElement("button");
    archive.type = "button";
    archive.textContent = "\u5F52\u6863\u7EC4\u5408";
    archive.addEventListener("click", () => onArchive(id));
    wrap.append(detail, archive);
    return wrap;
  }
  function detailContent(raw) {
    const value = parseJson2(raw);
    const wrap = document.createElement("div");
    wrap.className = "l-detail";
    if (!isRecord2(value)) {
      const p = document.createElement("p");
      p.className = "x-empty";
      p.textContent = "\u672C\u73AF\u5883\u4E0D\u63D0\u4F9B\u8BE5\u6570\u636E";
      wrap.appendChild(p);
      return wrap;
    }
    const positions = Array.isArray(value.positions) ? value.positions : [];
    const title = document.createElement("h3");
    title.textContent = `\u6301\u4ED3\u660E\u7EC6\uFF08${positions.length}\uFF09`;
    wrap.appendChild(title);
    if (positions.length === 0) {
      const p = document.createElement("p");
      p.className = "x-empty";
      p.textContent = "\u6682\u65E0\u6301\u4ED3";
      wrap.appendChild(p);
      return wrap;
    }
    const table = document.createElement("table");
    table.className = "p-table";
    for (const row of positions) {
      const tr = document.createElement("tr");
      if (!isRecord2(row)) {
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
  function mountPaperLedger(root2, client2) {
    const bar = document.createElement("div");
    bar.className = "x-form";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "\u7EC4\u5408\u540D\u79F0";
    const eventInput = document.createElement("input");
    eventInput.type = "text";
    eventInput.placeholder = "\u6765\u6E90\u4E8B\u4EF6";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "\u5237\u65B0\u7EC4\u5408";
    const create = document.createElement("button");
    create.type = "button";
    create.textContent = "\u521B\u5EFA\u7EC4\u5408";
    bar.append(nameInput, eventInput, refresh, create);
    const listHost = document.createElement("div");
    listHost.className = "l-host";
    const detailHost = document.createElement("div");
    detailHost.className = "l-host";
    root2.replaceChildren(bar, listHost, detailHost);
    let disposed = false;
    let generation = 0;
    async function load() {
      const round = ++generation;
      renderSection2(listHost, "loading", "");
      try {
        const raw = await client2.executeCommand({ name: LIST_ACTIVE });
        if (disposed || round !== generation) {
          return;
        }
        const value = parseJson2(raw);
        if (!Array.isArray(value) || value.length === 0) {
          renderSection2(listHost, "empty", "\u6682\u65E0\u6A21\u62DF\u7EC4\u5408");
          return;
        }
        const content = document.createElement("div");
        for (const row of value) {
          if (!isRecord2(row)) {
            continue;
          }
          content.appendChild(portfolioRow(row, voidDetail, voidArchive));
        }
        renderSection2(listHost, "ready", "", content);
      } catch (error) {
        if (disposed || round !== generation) {
          return;
        }
        renderSection2(listHost, "error", errorMessage2(error));
      }
    }
    async function callWithId(name, id, target) {
      if (disposed || id === "") {
        return;
      }
      const round = ++generation;
      renderSection2(target, "loading", "");
      try {
        const raw = await client2.executeCommand({ name, input: { portfolioId: id } });
        if (disposed || round !== generation) {
          return;
        }
        if (name === GET) {
          renderSection2(target, "ready", "", detailContent(raw));
        } else {
          await load();
        }
      } catch (error) {
        if (disposed || round !== generation) {
          return;
        }
        renderSection2(target, "error", errorMessage2(error));
      }
    }
    const voidDetail = (id) => {
      void callWithId(GET, id, detailHost);
    };
    const voidArchive = (id) => {
      void callWithId(ARCHIVE, id, listHost);
    };
    const onRefresh = () => {
      void load();
    };
    const onCreate = () => {
      const name = nameInput.value.trim();
      const sourceEvent = eventInput.value.trim();
      if (name === "" || sourceEvent === "") {
        renderSection2(detailHost, "empty", "\u672A\u53D1\u8C03\u7528\uFF1A\u8BF7\u586B\u5199\u7EC4\u5408\u540D\u79F0\u4E0E\u6765\u6E90\u4E8B\u4EF6");
        return;
      }
      void onCreateRequest(name, sourceEvent);
    };
    async function onCreateRequest(name, sourceEvent) {
      const round = ++generation;
      renderSection2(detailHost, "loading", "");
      try {
        const raw = await client2.executeCommand({ name: CREATE, input: { name, sourceEvent } });
        if (disposed || round !== generation) {
          return;
        }
        renderSection2(detailHost, "ready", "", detailContent(raw));
        nameInput.value = "";
        eventInput.value = "";
        await load();
      } catch (error) {
        if (disposed || round !== generation) {
          return;
        }
        renderSection2(detailHost, "error", errorMessage2(error));
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

  // src-web/portfolio.ts
  var COMMAND_DASHBOARD = "stock_get_portfolio_dashboard";
  function parseJson3(raw) {
    if (typeof raw !== "string") {
      return raw;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  function isRecord3(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function number(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  function money(value) {
    const n = number(value);
    return n === null ? "\u2014" : n.toFixed(2);
  }
  function percent(value) {
    const n = number(value);
    return n === null ? "\u2014" : `${n.toFixed(2)}%`;
  }
  function text2(value) {
    return typeof value === "string" && value !== "" ? value : "\u2014";
  }
  function renderSection3(host, state, detail, content) {
    host.replaceChildren();
    const section = document.createElement("section");
    section.className = "x-section";
    if (state === "loading") {
      const p = document.createElement("p");
      p.className = "x-empty";
      p.textContent = "\u53D6\u6570\u4E2D\u2026";
      section.appendChild(p);
    } else if (state === "error") {
      const p = document.createElement("p");
      p.className = "x-error";
      p.textContent = `\u8C03\u7528\u5931\u8D25\uFF1A${detail}`;
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
  function summaryCards(d) {
    const wrap = document.createElement("div");
    wrap.className = "p-summary";
    const cards = [
      ["\u603B\u5E02\u503C", money(d.totalMarketValue)],
      ["\u6D6E\u52A8\u76C8\u4E8F", money(d.totalPnl)],
      ["\u6536\u76CA\u7387", percent(d.totalPnlPct)],
      ["\u98CE\u9669\u7B49\u7EA7", text2(d.riskLevel)],
      ["\u5206\u6563\u5EA6", d.diversificationScore === void 0 ? "\u2014" : String(d.diversificationScore)],
      ["\u6700\u5927\u96C6\u4E2D\u5EA6", percent(d.topConcentrationPct)],
      ["\u672A\u5B9A\u4EF7\u6301\u4ED3", d.unpricedPositions === void 0 ? "\u2014" : String(d.unpricedPositions)],
      ["\u5FEB\u7167\u65E5\u671F", text2(d.asOfDate)]
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
  function positionsTable(rows) {
    const wrap = document.createElement("div");
    wrap.className = "p-table-wrap";
    const table = document.createElement("table");
    table.className = "p-table";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    const columns = ["\u4EE3\u7801", "\u540D\u79F0", "\u6570\u91CF", "\u6210\u672C", "\u73B0\u4EF7", "\u5E02\u503C", "\u6D6E\u52A8\u76C8\u4E8F"];
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
        text2(row.code),
        text2(row.name),
        row.quantity === void 0 ? "\u2014" : String(row.quantity),
        money(row.costBasis),
        money(row.lastPrice),
        money(row.marketValue),
        money(row.unrealizedPnl)
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
  function sectorBars(exposure) {
    const wrap = document.createElement("div");
    wrap.className = "p-sectors";
    const entries = Object.entries(exposure).filter(([, value]) => number(value) !== null);
    const max = Math.max(0, ...entries.map(([, value]) => number(value) ?? 0));
    for (const [name, value] of entries) {
      const ratio = max > 0 ? (number(value) ?? 0) / max * 100 : 0;
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
  function stressTests(stress) {
    const wrap = document.createElement("div");
    wrap.className = "p-stress";
    const labels = [
      ["m10", "\u4E0B\u8DCC 10%"],
      ["m20", "\u4E0B\u8DCC 20%"],
      ["blackSwan", "\u9ED1\u5929\u9E45"]
    ];
    for (const [key, label] of labels) {
      const item = document.createElement("div");
      item.className = "p-stress-item";
      const value = stress[key];
      const valueText = isRecord3(value) ? Object.entries(value).map(([k, v]) => `${k}: ${typeof v === "number" ? money(v) : String(v)}`).join(" \xB7 ") : value === void 0 || value === null ? "\u65E0\u6570\u636E" : String(value);
      item.textContent = `${label}\uFF1A${valueText}`;
      wrap.appendChild(item);
    }
    return wrap;
  }
  function renderDashboard(host, raw) {
    const value = parseJson3(raw);
    if (!isRecord3(value)) {
      renderSection3(host, "empty", "\u672C\u73AF\u5883\u4E0D\u63D0\u4F9B\u8BE5\u6570\u636E");
      return;
    }
    const d = value;
    const rows = Array.isArray(d.positions) ? d.positions : [];
    if (rows.length === 0 && number(d.totalMarketValue) === null) {
      renderSection3(host, "empty", "\u6682\u65E0\u6301\u4ED3\u6570\u636E");
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
    positionsTitle.textContent = `\u6301\u4ED3\u660E\u7EC6\uFF08${rows.length}\uFF09`;
    positionsSection.appendChild(positionsTitle);
    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "x-empty";
      empty.textContent = "\u6682\u65E0\u6301\u4ED3";
      positionsSection.appendChild(empty);
    } else {
      positionsSection.appendChild(positionsTable(rows));
    }
    content.appendChild(positionsSection);
    if (d.sectorExposure && Object.keys(d.sectorExposure).length > 0) {
      const sectorSection = document.createElement("section");
      sectorSection.className = "x-section";
      const sectorTitle = document.createElement("h3");
      sectorTitle.textContent = "\u884C\u4E1A\u66B4\u9732";
      sectorSection.appendChild(sectorTitle);
      sectorSection.appendChild(sectorBars(d.sectorExposure));
      content.appendChild(sectorSection);
    }
    if (d.stressTest && Object.keys(d.stressTest).length > 0) {
      const stressSection = document.createElement("section");
      stressSection.className = "x-section";
      const stressTitle = document.createElement("h3");
      stressTitle.textContent = "\u538B\u529B\u6D4B\u8BD5";
      stressSection.appendChild(stressTitle);
      stressSection.appendChild(stressTests(d.stressTest));
      content.appendChild(stressSection);
    }
    renderSection3(host, "ready", "", content);
  }
  function errorMessage3(error) {
    if (error instanceof Error) {
      return error.message;
    }
    return typeof error === "string" ? error : JSON.stringify(error);
  }
  function mountPortfolio(root2, client2) {
    const bar = document.createElement("div");
    bar.className = "x-form";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "\u5237\u65B0\u6301\u4ED3";
    bar.appendChild(refresh);
    const host = document.createElement("div");
    host.className = "p-host";
    root2.replaceChildren(bar, host);
    let disposed = false;
    let generation = 0;
    async function load() {
      const round = ++generation;
      renderSection3(host, "loading", "");
      try {
        const raw = await client2.executeCommand({ name: COMMAND_DASHBOARD });
        if (disposed || round !== generation) {
          return;
        }
        renderDashboard(host, raw);
      } catch (error) {
        if (disposed || round !== generation) {
          return;
        }
        renderSection3(host, "error", errorMessage3(error));
      }
    }
    const onClick = () => {
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

  // src-web/quant.ts
  var STRATEGIES = "stock_quant_strategies_list";
  var RUN_GET = "stock_quant_run_get";
  var METRICS_COMPARE = "stock_quant_metrics_compare";
  function parseJson4(raw) {
    if (typeof raw !== "string") {
      return raw;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  function isRecord4(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function text3(value) {
    return typeof value === "string" && value !== "" ? value : "\u2014";
  }
  function renderSection4(host, state, detail, content) {
    host.replaceChildren();
    const section = document.createElement("section");
    section.className = "x-section";
    if (state === "ready" && content) {
      section.appendChild(content);
    } else {
      const p = document.createElement("p");
      p.className = state === "error" ? "x-error" : "x-empty";
      const label = {
        loading: "\u53D6\u6570\u4E2D\u2026",
        error: `\u8C03\u7528\u5931\u8D25\uFF1A${detail}`,
        empty: detail,
        skipped: detail,
        ready: detail
      };
      p.textContent = label[state];
      section.appendChild(p);
    }
    host.appendChild(section);
  }
  function strategyTable(rows) {
    const wrap = document.createElement("div");
    wrap.className = "p-table-wrap";
    const table = document.createElement("table");
    table.className = "p-table";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["\u7B56\u7565\u540D\u79F0", "\u7248\u672C", "\u8BF4\u660E", "ID"]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    table.appendChild(head);
    const body = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      for (const value of [text3(row.name), text3(row.version), text3(row.description), text3(row.id)]) {
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
  function jsonBlock(value) {
    const pre = document.createElement("pre");
    pre.className = "x-json";
    pre.textContent = JSON.stringify(value, null, 2);
    return pre;
  }
  function errorMessage4(error) {
    if (error instanceof Error) {
      return error.message;
    }
    return typeof error === "string" ? error : JSON.stringify(error);
  }
  function mountQuant(root2, client2) {
    const bar = document.createElement("div");
    bar.className = "x-form";
    const reload = document.createElement("button");
    reload.type = "button";
    reload.textContent = "\u5237\u65B0\u7B56\u7565";
    bar.appendChild(reload);
    const runLabel = document.createElement("label");
    runLabel.textContent = "\u8FD0\u884C ID";
    const runInput = document.createElement("input");
    runInput.type = "text";
    runLabel.appendChild(runInput);
    bar.appendChild(runLabel);
    const runButton = document.createElement("button");
    runButton.type = "button";
    runButton.textContent = "\u67E5\u8FD0\u884C\u8BE6\u60C5";
    bar.appendChild(runButton);
    const compareLabel = document.createElement("label");
    compareLabel.textContent = "\u5BF9\u6BD4 ID\uFF08\u9017\u53F7\u5206\u9694\uFF09";
    const compareInput = document.createElement("input");
    compareInput.type = "text";
    compareLabel.appendChild(compareInput);
    bar.appendChild(compareLabel);
    const compareButton = document.createElement("button");
    compareButton.type = "button";
    compareButton.textContent = "\u5BF9\u6BD4\u6307\u6807";
    bar.appendChild(compareButton);
    const grid = document.createElement("div");
    grid.className = "x-grid";
    const strategyHost = document.createElement("div");
    const runHost = document.createElement("div");
    const compareHost = document.createElement("div");
    grid.append(strategyHost, runHost, compareHost);
    root2.replaceChildren(bar, grid);
    let disposed = false;
    let strategyRound = 0;
    let runRound = 0;
    let compareRound = 0;
    async function loadStrategies() {
      const round = ++strategyRound;
      renderSection4(strategyHost, "loading", "");
      try {
        const value = parseJson4(await client2.executeCommand({ name: STRATEGIES }));
        if (disposed || round !== strategyRound) {
          return;
        }
        if (!Array.isArray(value)) {
          renderSection4(strategyHost, "empty", "\u672C\u73AF\u5883\u4E0D\u63D0\u4F9B\u8BE5\u6570\u636E");
          return;
        }
        if (value.length === 0) {
          renderSection4(strategyHost, "empty", "\u6682\u65E0\u91CF\u5316\u7B56\u7565");
          return;
        }
        const rows = value.filter(isRecord4);
        const content = document.createElement("div");
        content.className = "q-strategies";
        const title = document.createElement("h3");
        title.textContent = `\u7B56\u7565\u5217\u8868\uFF08${rows.length}\uFF09`;
        content.appendChild(title);
        content.appendChild(strategyTable(rows));
        renderSection4(strategyHost, "ready", "", content);
      } catch (error) {
        if (disposed || round !== strategyRound) {
          return;
        }
        renderSection4(strategyHost, "error", errorMessage4(error));
      }
    }
    async function loadRun() {
      const runId = runInput.value.trim();
      if (!runId) {
        renderSection4(runHost, "skipped", "\u8BF7\u586B\u5199\u8FD0\u884C ID \u540E\u518D\u67E5\u8BE2\uFF08\u672A\u53D1\u8C03\u7528\uFF09");
        return;
      }
      const round = ++runRound;
      renderSection4(runHost, "loading", "");
      try {
        const value = parseJson4(await client2.executeCommand({ name: RUN_GET, input: { runId } }));
        if (disposed || round !== runRound) {
          return;
        }
        if (!isRecord4(value) || Object.keys(value).length === 0) {
          renderSection4(runHost, "empty", "\u672A\u627E\u5230\u8BE5\u8FD0\u884C\u8BB0\u5F55");
          return;
        }
        const content = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = `\u8FD0\u884C\u8BE6\u60C5\uFF1A${runId}`;
        content.appendChild(title);
        content.appendChild(jsonBlock(value));
        renderSection4(runHost, "ready", "", content);
      } catch (error) {
        if (disposed || round !== runRound) {
          return;
        }
        renderSection4(runHost, "error", errorMessage4(error));
      }
    }
    async function loadCompare() {
      const runIds = compareInput.value.split(",").map((part) => part.trim()).filter((part) => part !== "");
      if (runIds.length === 0) {
        renderSection4(compareHost, "skipped", "\u8BF7\u586B\u5199\u81F3\u5C11\u4E00\u4E2A\u8FD0\u884C ID\uFF08\u672A\u53D1\u8C03\u7528\uFF09");
        return;
      }
      const round = ++compareRound;
      renderSection4(compareHost, "loading", "");
      try {
        const value = parseJson4(await client2.executeCommand({ name: METRICS_COMPARE, input: { runIds } }));
        if (disposed || round !== compareRound) {
          return;
        }
        if (!isRecord4(value) || Object.keys(value).length === 0) {
          renderSection4(compareHost, "empty", "\u6CA1\u6709\u53EF\u5BF9\u6BD4\u7684\u6307\u6807");
          return;
        }
        const content = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = `\u6307\u6807\u5BF9\u6BD4\uFF08${runIds.length} \u4E2A\u8FD0\u884C\uFF09`;
        content.appendChild(title);
        content.appendChild(jsonBlock(value));
        renderSection4(compareHost, "ready", "", content);
      } catch (error) {
        if (disposed || round !== compareRound) {
          return;
        }
        renderSection4(compareHost, "error", errorMessage4(error));
      }
    }
    const onReload = () => {
      void loadStrategies();
    };
    const onRun = () => {
      void loadRun();
    };
    const onCompare = () => {
      void loadCompare();
    };
    reload.addEventListener("click", onReload);
    runButton.addEventListener("click", onRun);
    compareButton.addEventListener("click", onCompare);
    renderSection4(runHost, "skipped", "\u8BF7\u586B\u5199\u8FD0\u884C ID \u540E\u518D\u67E5\u8BE2\uFF08\u672A\u53D1\u8C03\u7528\uFF09");
    renderSection4(compareHost, "skipped", "\u8BF7\u586B\u5199\u81F3\u5C11\u4E00\u4E2A\u8FD0\u884C ID\uFF08\u672A\u53D1\u8C03\u7528\uFF09");
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

  // src-web/screener.ts
  var POOL_BATCH = "stock_get_reco_pool_batch";
  var BOARD_SCOPE = "stock_get_reco_board_scope";
  var HOT_STOCKS = "stock_get_hot_stocks";
  var LIMIT_UP = "stock_get_limit_up_pool";
  var DRAGON_TIGER = "stock_get_market_dragon_tiger";
  var RECO_HISTORY = "stock_list_reco_history";
  var LATEST_ANALYSES = "stock_get_latest_analyses_for_stocks";
  var BASE_COMMANDS = [
    { name: POOL_BATCH, title: "\u5B9E\u76D8\u5019\u9009\u6C60\u6279\u6B21", input: void 0 },
    { name: BOARD_SCOPE, title: "\u626B\u63CF\u677F\u5757\u8303\u56F4", input: void 0 },
    { name: HOT_STOCKS, title: "\u70ED\u95E8\u80A1\u7968\u699C", input: void 0 },
    { name: LIMIT_UP, title: "\u6DA8\u505C\u6C60", input: void 0 },
    { name: DRAGON_TIGER, title: "\u5168\u5E02\u573A\u9F99\u864E\u699C", input: void 0 },
    { name: RECO_HISTORY, title: "\u8350\u80A1\u5386\u53F2", input: { limit: 20, offset: 0 } }
  ];
  function parseJson5(raw) {
    if (typeof raw !== "string") {
      return raw;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  function isRecord5(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function display(value) {
    if (value === null || value === void 0 || value === "") {
      return "\u2014";
    }
    if (typeof value === "object") {
      return JSON.stringify(value);
    }
    return String(value);
  }
  function renderSection5(host, state, detail, content) {
    host.replaceChildren();
    const section = document.createElement("section");
    section.className = "x-section";
    if (state === "ready" && content) {
      section.appendChild(content);
    } else {
      const p = document.createElement("p");
      p.className = state === "error" ? "x-error" : "x-empty";
      const labels = {
        loading: "\u53D6\u6570\u4E2D\u2026",
        error: `\u8C03\u7528\u5931\u8D25\uFF1A${detail}`,
        empty: detail,
        skipped: detail,
        ready: detail
      };
      p.textContent = labels[state];
      section.appendChild(p);
    }
    host.appendChild(section);
  }
  function listTable(rows, title, maxRows = 8) {
    const wrap = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = `${title}\uFF08${rows.length}\uFF09`;
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
  function jsonBlock2(value) {
    const pre = document.createElement("pre");
    pre.className = "x-json";
    pre.textContent = JSON.stringify(value, null, 2);
    return pre;
  }
  function renderPool(host, raw) {
    const value = parseJson5(raw);
    if (!isRecord5(value)) {
      renderSection5(host, "empty", "\u8BE5\u94FE\u6682\u65E0\u5B9E\u76D8\u6279\u6B21\u7559\u75D5");
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
    renderSection5(host, "ready", "", wrap);
  }
  function stockCodes(raw) {
    const value = parseJson5(raw);
    if (!Array.isArray(value)) {
      return [];
    }
    const codes = [];
    for (const item of value) {
      if (!isRecord5(item)) {
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
  function errorMessage5(error) {
    if (error instanceof Error) {
      return error.message;
    }
    return typeof error === "string" ? error : JSON.stringify(error);
  }
  function mountScreener(root2, client2) {
    const bar = document.createElement("div");
    bar.className = "x-form";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "\u5237\u65B0\u9009\u80A1\u6570\u636E";
    bar.appendChild(refresh);
    const grid = document.createElement("div");
    grid.className = "x-grid";
    const hosts = /* @__PURE__ */ new Map();
    for (const command of BASE_COMMANDS) {
      const host = document.createElement("div");
      hosts.set(command.name, host);
      grid.appendChild(host);
    }
    const detailHost = document.createElement("div");
    grid.appendChild(detailHost);
    root2.replaceChildren(bar, grid);
    let disposed = false;
    let generation = 0;
    async function refreshData() {
      const round = ++generation;
      for (const command of BASE_COMMANDS) {
        const host = hosts.get(command.name);
        if (host) {
          renderSection5(host, "loading", "");
        }
      }
      renderSection5(detailHost, "loading", "");
      const results = await Promise.all(BASE_COMMANDS.map(async (command) => {
        try {
          const raw = await client2.executeCommand({
            name: command.name,
            ...command.input === void 0 ? {} : { input: command.input }
          });
          return { command, raw, error: null };
        } catch (error) {
          return { command, raw: void 0, error: errorMessage5(error) };
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
          renderSection5(host, "error", item.error);
          continue;
        }
        if (item.command.name === POOL_BATCH) {
          renderPool(host, item.raw);
          continue;
        }
        const value = parseJson5(item.raw);
        if (Array.isArray(value) && value.length === 0) {
          renderSection5(host, "empty", "\u672C\u73AF\u5883\u4E0D\u63D0\u4F9B\u8BE5\u6570\u636E");
        } else if (Array.isArray(value)) {
          renderSection5(host, "ready", "", listTable(value.filter(isRecord5), item.command.title));
        } else if (isRecord5(value) && Object.keys(value).length > 0) {
          renderSection5(host, "ready", "", jsonBlock2(value));
        } else {
          renderSection5(host, "empty", "\u672C\u73AF\u5883\u4E0D\u63D0\u4F9B\u8BE5\u6570\u636E");
        }
      }
      const hot = results.find((item) => item.command.name === HOT_STOCKS);
      const codes = hot && hot.error === null ? stockCodes(hot.raw) : [];
      if (codes.length === 0) {
        renderSection5(detailHost, "skipped", "\u70ED\u80A1\u699C\u6CA1\u6709\u53EF\u7528 6 \u4F4D\u80A1\u7968\u4EE3\u7801\uFF0C\u672A\u53D1\u51B3\u7B56\u6458\u8981\u67E5\u8BE2");
        return;
      }
      try {
        const raw = await client2.executeCommand({
          name: LATEST_ANALYSES,
          input: { stockCodes: codes }
        });
        if (disposed || round !== generation) {
          return;
        }
        const value = parseJson5(raw);
        const rows = Array.isArray(value) ? value.filter(isRecord5) : [];
        if (rows.length === 0) {
          renderSection5(detailHost, "empty", "\u672A\u67E5\u5230\u8FD9\u4E9B\u80A1\u7968\u7684\u6700\u8FD1\u5206\u6790");
        } else {
          renderSection5(detailHost, "ready", "", listTable(rows, "\u6700\u8FD1\u51B3\u7B56\u6458\u8981", 5));
        }
      } catch (error) {
        if (disposed || round !== generation) {
          return;
        }
        renderSection5(detailHost, "error", errorMessage5(error));
      }
    }
    const onClick = () => {
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

  // src-web/screenshotDiagnosis.ts
  var LIST_RECENT = "screenshot_diagnosis_list_recent";
  var GET2 = "screenshot_diagnosis_get";
  var ARCHIVE2 = "screenshot_diagnosis_archive";
  var TO_PORTFOLIO = "screenshot_diagnosis_to_paper_portfolio";
  var CREATE_FROM_IMAGE = "screenshot_diagnosis_create_from_image";
  function parseJson6(raw) {
    if (typeof raw !== "string") {
      return raw;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  function isRecord6(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function text4(value) {
    return typeof value === "string" && value !== "" ? value : "\u2014";
  }
  function numberText2(value) {
    return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "\u2014";
  }
  function errorMessage6(error) {
    if (error instanceof Error) {
      return error.message;
    }
    return typeof error === "string" ? error : JSON.stringify(error);
  }
  function renderSection6(host, state, detail, content) {
    host.replaceChildren();
    const section = document.createElement("section");
    section.className = "x-section";
    if (state === "loading") {
      const p = document.createElement("p");
      p.className = "x-empty";
      p.textContent = "\u53D6\u6570\u4E2D\u2026";
      section.appendChild(p);
    } else if (state === "error") {
      const p = document.createElement("p");
      p.className = "x-error";
      p.textContent = `\u8C03\u7528\u5931\u8D25\uFF1A${detail}`;
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
  function detailContent2(raw) {
    const value = parseJson6(raw);
    const wrap = document.createElement("div");
    wrap.className = "d-detail";
    if (!isRecord6(value)) {
      const p = document.createElement("p");
      p.className = "x-empty";
      p.textContent = "\u672C\u73AF\u5883\u4E0D\u63D0\u4F9B\u8BE5\u6570\u636E";
      wrap.appendChild(p);
      return wrap;
    }
    const narrative = document.createElement("p");
    narrative.textContent = text4(value.narrative);
    wrap.appendChild(narrative);
    const positions = parseJson6(value.positionsJson);
    const rows = Array.isArray(positions) ? positions : [];
    const title = document.createElement("h3");
    title.textContent = `\u8BC6\u522B\u6301\u4ED3\uFF08${rows.length}\uFF09`;
    wrap.appendChild(title);
    const pre = document.createElement("pre");
    pre.textContent = rows.length > 0 ? rows.map((row) => isRecord6(row) ? `${text4(row.code)} ${text4(row.name)} \xB7 \u6570\u91CF ${numberText2(row.qty)} \xB7 \u5E02\u503C ${numberText2(row.marketValue)}` : String(row)).join("\n") : "\u2014";
    wrap.appendChild(pre);
    return wrap;
  }
  function mountScreenshotDiagnosis(root2, client2) {
    const bar = document.createElement("div");
    bar.className = "x-form";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/png,image/jpeg";
    const providerInput = document.createElement("input");
    providerInput.type = "text";
    providerInput.placeholder = "\u89C6\u89C9\u6A21\u578B provider id";
    const modelInput = document.createElement("input");
    modelInput.type = "text";
    modelInput.placeholder = "\u89C6\u89C9\u6A21\u578B model id";
    const upload = document.createElement("button");
    upload.type = "button";
    upload.textContent = "\u4E0A\u4F20\u5E76\u8BCA\u65AD";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "\u5237\u65B0\u8BCA\u65AD";
    bar.append(fileInput, providerInput, modelInput, upload, refresh);
    const listHost = document.createElement("div");
    listHost.className = "d-host";
    const detailHost = document.createElement("div");
    detailHost.className = "d-host";
    const actionHost = document.createElement("div");
    actionHost.className = "d-host";
    const convertName = document.createElement("input");
    convertName.type = "text";
    convertName.placeholder = "\u8F6C\u7EC4\u5408\u540D\u79F0";
    const convertEvent = document.createElement("input");
    convertEvent.type = "text";
    convertEvent.placeholder = "\u6765\u6E90\u4E8B\u4EF6";
    actionHost.append(convertName, convertEvent);
    root2.replaceChildren(bar, listHost, detailHost, actionHost);
    let disposed = false;
    let generation = 0;
    async function load() {
      const round = ++generation;
      renderSection6(listHost, "loading", "");
      try {
        const raw = await client2.executeCommand({ name: LIST_RECENT, input: { limit: 20 } });
        if (disposed || round !== generation) {
          return;
        }
        const value = parseJson6(raw);
        if (!Array.isArray(value) || value.length === 0) {
          renderSection6(listHost, "empty", "\u6682\u65E0\u622A\u56FE\u8BCA\u65AD");
          return;
        }
        const content = document.createElement("div");
        for (const row of value) {
          if (!isRecord6(row)) {
            continue;
          }
          content.appendChild(diagnosisRow(row));
        }
        renderSection6(listHost, "ready", "", content);
      } catch (error) {
        if (disposed || round !== generation) {
          return;
        }
        renderSection6(listHost, "error", errorMessage6(error));
      }
    }
    function diagnosisRow(row) {
      const wrap = document.createElement("div");
      wrap.className = "d-row";
      const labels = [
        `\u6765\u6E90\uFF1A${text4(row.sourceApp)}`,
        `\u72B6\u6001\uFF1A${text4(row.status)}`,
        `\u603B\u5E02\u503C\uFF1A${numberText2(row.totalMarketValue)}`,
        `\u521B\u5EFA\u65F6\u95F4\uFF1A${typeof row.createdAt === "number" ? String(row.createdAt) : "\u2014"}`
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
        hint.textContent = "\u56DE\u6267\u7F3A id\uFF0C\u672A\u53D1\u8BE6\u60C5/\u5F52\u6863/\u8F6C\u7EC4\u5408\u8C03\u7528";
        wrap.appendChild(hint);
        return wrap;
      }
      const detail = document.createElement("button");
      detail.type = "button";
      detail.textContent = "\u8BCA\u65AD\u8BE6\u60C5";
      detail.addEventListener("click", () => void callById(GET2, id, detailHost, {}));
      const archive = document.createElement("button");
      archive.type = "button";
      archive.textContent = "\u5F52\u6863\u8BCA\u65AD";
      archive.addEventListener("click", () => void callById(ARCHIVE2, id, listHost, {}));
      const convert = document.createElement("button");
      convert.type = "button";
      convert.textContent = "\u8F6C\u4E3A\u7EC4\u5408";
      convert.addEventListener("click", () => {
        const name = convertName.value.trim();
        const sourceEvent = convertEvent.value.trim();
        if (name === "" || sourceEvent === "") {
          renderSection6(actionHost, "empty", "\u672A\u53D1\u8C03\u7528\uFF1A\u8BF7\u586B\u5199\u7EC4\u5408\u540D\u79F0\u4E0E\u6765\u6E90\u4E8B\u4EF6");
          return;
        }
        void callById(TO_PORTFOLIO, id, actionHost, { name, sourceEvent });
      });
      wrap.append(detail, archive, convert);
      return wrap;
    }
    async function callById(name, diagnosisId, target, extra) {
      if (disposed || diagnosisId === "") {
        return;
      }
      const round = ++generation;
      renderSection6(target, "loading", "");
      try {
        const raw = await client2.executeCommand({
          name,
          input: { diagnosisId, ...extra }
        });
        if (disposed || round !== generation) {
          return;
        }
        if (name === GET2) {
          renderSection6(target, "ready", "", detailContent2(raw));
        } else {
          const result = parseJson6(raw);
          const done = document.createElement("p");
          done.textContent = `\u5DF2${name === ARCHIVE2 ? "\u5F52\u6863" : "\u8F6C\u4E3A\u7EC4\u5408"}\uFF1A${isRecord6(result) ? text4(result.id) : "\u5B8C\u6210"}`;
          renderSection6(target, "ready", "", done);
          await load();
        }
      } catch (error) {
        if (disposed || round !== generation) {
          return;
        }
        renderSection6(target, "error", errorMessage6(error));
      }
    }
    function onUpload() {
      const providerId = providerInput.value.trim();
      const modelId = modelInput.value.trim();
      const file = fileInput.files?.[0];
      if (!file || providerId === "" || modelId === "") {
        renderSection6(actionHost, "empty", "\u672A\u53D1\u8C03\u7528\uFF1A\u8BF7\u9009\u62E9\u622A\u56FE\u5E76\u586B\u5199 provider / model");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const imageBase64 = typeof reader.result === "string" ? reader.result : "";
        if (imageBase64 === "") {
          renderSection6(actionHost, "empty", "\u672A\u53D1\u8C03\u7528\uFF1A\u56FE\u7247\u8BFB\u53D6\u5931\u8D25");
          return;
        }
        const round = ++generation;
        renderSection6(actionHost, "loading", "");
        void client2.executeCommand({
          name: CREATE_FROM_IMAGE,
          input: { imageBase64, sourceApp: "\u5176\u4ED6", providerId, modelId }
        }).then((raw) => {
          if (disposed || round !== generation) {
            return;
          }
          renderSection6(actionHost, "ready", "", detailContent2(raw));
          return load();
        }).catch((error) => {
          if (!disposed && round === generation) {
            renderSection6(actionHost, "error", errorMessage6(error));
          }
        });
      };
      reader.readAsDataURL(file);
    }
    const onRefresh = () => {
      void load();
    };
    refresh.addEventListener("click", onRefresh);
    upload.addEventListener("click", onUpload);
    void load();
    return () => {
      disposed = true;
      ++generation;
      refresh.removeEventListener("click", onRefresh);
      upload.removeEventListener("click", onUpload);
    };
  }

  // src-web/workspace.ts
  var VIEWS = [
    ["analysis", "\u5206\u6790"],
    ["monitor", "\u76D1\u63A7"],
    ["trade", "\u4EA4\u6613"],
    ["backtest", "\u56DE\u6D4B"],
    ["compare", "\u5BF9\u6BD4"],
    ["review", "\u590D\u76D8"]
  ];
  var EMPTY_TEXT = "\u672C\u73AF\u5883\u4E0D\u63D0\u4F9B\u8BE5\u6570\u636E";
  function parseJson7(raw) {
    if (typeof raw !== "string") {
      return raw;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  function isRecord7(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function errorMessage7(error) {
    if (error instanceof Error) {
      return error.message;
    }
    return typeof error === "string" ? error : JSON.stringify(error);
  }
  function callsFor(view, stockCode) {
    switch (view) {
      case "analysis":
        return [
          { name: "stock_get_quote", input: { stockCode } },
          { name: "stock_get_financials", input: { stockCode } }
        ];
      case "monitor":
        return [
          { name: "stock_list_portfolio" },
          { name: "stock_list_price_alerts" }
        ];
      case "trade":
        return [
          { name: "stock_get_trade_positions" },
          { name: "stock_list_trades", input: { stockCode, limit: 50 } }
        ];
      case "backtest":
        return [{ name: "stock_get_recent_analyses", input: { limit: 5 } }];
      case "compare":
        return [{ name: "stock_list_stock_analyses", input: { limit: 5, offset: 0 } }];
      case "review":
        return [{ name: "stock_list_reflections", input: { stockCode, limit: 10 } }];
    }
  }
  function firstAnalysisId(raw) {
    const value = parseJson7(raw);
    const rows = Array.isArray(value) ? value : isRecord7(value) && Array.isArray(value.rows) ? value.rows : [];
    for (const row of rows) {
      if (isRecord7(row)) {
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
  function isEmpty(value) {
    if (value === null || value === void 0) {
      return true;
    }
    if (Array.isArray(value)) {
      return value.length === 0;
    }
    if (isRecord7(value)) {
      return Object.keys(value).length === 0;
    }
    return false;
  }
  function renderOutcome(host, call2, outcome) {
    const section = document.createElement("section");
    section.className = "x-section";
    const title = document.createElement("h3");
    title.textContent = call2.name;
    section.appendChild(title);
    const pre = document.createElement("pre");
    pre.className = "x-json";
    if (outcome.kind === "error") {
      pre.textContent = `\u8C03\u7528\u5931\u8D25\uFF1A${outcome.message}`;
    } else if (outcome.kind === "skipped") {
      pre.textContent = `\u672A\u53D1\u8C03\u7528\uFF1A${outcome.reason}`;
    } else {
      const value = parseJson7(outcome.raw);
      pre.textContent = isEmpty(value) ? EMPTY_TEXT : JSON.stringify(value, null, 2);
    }
    section.appendChild(pre);
    host.appendChild(section);
  }
  async function invokeOne(client2, call2) {
    try {
      const raw = await client2.executeCommand(call2.input === void 0 ? { name: call2.name } : { name: call2.name, input: call2.input });
      return { kind: "ok", raw };
    } catch (error) {
      return { kind: "error", message: errorMessage7(error) };
    }
  }
  function mountWorkspace(root2, client2) {
    const bar = document.createElement("div");
    bar.className = "x-form";
    const codeInput = document.createElement("input");
    codeInput.type = "text";
    codeInput.placeholder = "\u80A1\u7968\u4EE3\u7801";
    codeInput.value = "600519";
    const hint = document.createElement("span");
    hint.className = "x-empty";
    hint.textContent = "\u7A7A\u4EE3\u7801\u4E0D\u53D1\u8C03\u7528";
    bar.append(codeInput, hint);
    const nav = document.createElement("nav");
    nav.className = "stock-tabs w-tabs";
    const views = /* @__PURE__ */ new Map();
    const loaded = /* @__PURE__ */ new Set();
    const generations = /* @__PURE__ */ new Map();
    const buttons = /* @__PURE__ */ new Map();
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
    root2.replaceChildren(bar, nav, ...VIEWS.map(([id]) => views.get(id)));
    let disposed = false;
    let active = "analysis";
    async function load(view) {
      const host = views.get(view);
      if (!host || disposed) {
        return;
      }
      const round = (generations.get(view) ?? 0) + 1;
      generations.set(view, round);
      host.replaceChildren();
      const stockCode = codeInput.value.trim();
      if (stockCode === "") {
        renderOutcome(host, { name: "\u672C\u89C6\u56FE" }, { kind: "skipped", reason: "\u80A1\u7968\u4EE3\u7801\u4E3A\u7A7A\uFF0C\u672A\u53D1\u8C03\u7528" });
        return;
      }
      for (const call2 of callsFor(view, stockCode)) {
        const outcome = await invokeOne(client2, call2);
        if (disposed || generations.get(view) !== round) {
          return;
        }
        renderOutcome(host, call2, outcome);
        if (view === "compare" && call2.name === "stock_list_stock_analyses" && outcome.kind === "ok") {
          const analysisId = firstAnalysisId(outcome.raw);
          const detailCall = { name: "stock_get_stock_analysis", input: { analysisId: analysisId ?? "" } };
          if (analysisId === null) {
            renderOutcome(host, detailCall, { kind: "skipped", reason: "\u5206\u6790\u5217\u8868\u65E0\u53EF\u7528\u7684 analysisId\uFF0C\u672A\u53D1\u8C03\u7528" });
          } else {
            const detail = await invokeOne(client2, detailCall);
            if (disposed || generations.get(view) !== round) {
              return;
            }
            renderOutcome(host, detailCall, detail);
          }
        }
      }
    }
    function activate(id) {
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
    const onCodeChange = () => {
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

  // src-web/main.ts
  var client = createAxAgentPluginClient();
  client.announceReady();
  var BASE_CALLS = [
    { name: "stock_reflection_stats" },
    { name: "stock_reco_ic_stats", input: {} },
    { name: "stock_get_reco_strategy_weights" },
    { name: "stock_get_market_status" },
    { name: "stock_get_vendor_fallback_log" },
    { name: "stock_list_reco_history", input: { limit: 20, offset: 0 } },
    { name: "stock_list_stock_tools" }
  ];
  var PERIOD_VARIANTS = ["ultra_short", "short", "long", "mid"];
  var EMPTY_TEXT2 = "\u672C\u73AF\u5883\u4E0D\u63D0\u4F9B\u8BE5\u6570\u636E";
  function isEmpty2(value) {
    if (value === null || value === void 0) {
      return true;
    }
    if (Array.isArray(value)) {
      return value.length === 0;
    }
    if (typeof value === "object") {
      return Object.keys(value).length === 0;
    }
    return false;
  }
  function parseReceipt(raw) {
    if (typeof raw !== "string") {
      return raw;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  function parseRecoRows(raw) {
    const value = parseReceipt(raw);
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((row) => row !== null && typeof row === "object");
  }
  function extractStrategyId(raw) {
    const value = parseReceipt(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    for (const key of Object.keys(value)) {
      for (const period of PERIOD_VARIANTS) {
        const suffix = `_${period}`;
        if (key.endsWith(suffix) && key.length > suffix.length) {
          return key.slice(0, key.length - suffix.length);
        }
      }
    }
    return null;
  }
  function resolveDependentCalls(firstRound) {
    const rows = parseRecoRows(firstRound.get("stock_list_reco_history"));
    const detailRow = rows.find(
      (row) => typeof row.generatedAt === "string" && row.generatedAt !== ""
    );
    const cachedRow = rows.find(
      (row) => typeof row.period === "string" && PERIOD_VARIANTS.includes(row.period)
    );
    const strategyId = extractStrategyId(firstRound.get("stock_get_reco_strategy_weights"));
    return [
      detailRow ? {
        call: { name: "stock_get_reco_detail", input: { generatedAt: detailRow.generatedAt } },
        skip: null
      } : {
        call: { name: "stock_get_reco_detail" },
        skip: "\u5E93\u4E2D\u6682\u65E0\u8350\u80A1\u8BB0\u5F55\uFF08\u7F3A generatedAt\uFF09\uFF0C\u672A\u53D1\u8C03\u7528"
      },
      cachedRow ? {
        call: { name: "stock_get_cached_recommendation", input: { period: cachedRow.period } },
        skip: null
      } : {
        call: { name: "stock_get_cached_recommendation" },
        skip: "\u5E93\u4E2D\u6682\u65E0\u5E26\u5408\u6CD5\u6863\u4F4D\uFF08period\uFF09\u7684\u8350\u80A1\u8BB0\u5F55\uFF0C\u672A\u53D1\u8C03\u7528"
      },
      strategyId ? {
        call: { name: "stock_get_reco_signal_history", input: { strategyId } },
        skip: null
      } : {
        call: { name: "stock_get_reco_signal_history" },
        skip: "\u6743\u91CD\u53F0\u8D26\u4E3A\u7A7A\uFF08\u65E0 {strategy}_{period} \u952E\uFF09\uFF0C\u65E0\u6CD5\u786E\u5B9A\u7B56\u7565 id\uFF0C\u672A\u53D1\u8C03\u7528"
      }
    ];
  }
  async function invokeOne2(call2) {
    try {
      const raw = await client.executeCommand({
        name: call2.name,
        ...call2.input === void 0 ? {} : { input: call2.input }
      });
      return { kind: "receipt", raw };
    } catch (error) {
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }
  function renderSection7(host, name, outcome) {
    const section = document.createElement("section");
    section.style.cssText = "margin:0 0 12px;padding:8px 10px;border:1px solid #ddd;border-radius:6px";
    const title = document.createElement("h2");
    title.style.cssText = "margin:0 0 6px;font-size:13px;font-weight:600";
    title.textContent = name;
    section.appendChild(title);
    const pre = document.createElement("pre");
    pre.style.cssText = "margin:0;white-space:pre-wrap;word-break:break-all;font:12px/1.5 ui-monospace,monospace";
    if (outcome.kind === "error") {
      pre.textContent = `\u8C03\u7528\u5931\u8D25\uFF1A${outcome.message}`;
    } else if (outcome.kind === "skipped") {
      pre.textContent = `\u672A\u53D1\u8C03\u7528\uFF1A${outcome.reason}`;
    } else {
      const value = parseReceipt(outcome.raw);
      pre.textContent = isEmpty2(value) ? EMPTY_TEXT2 : JSON.stringify(value, null, 2);
    }
    section.appendChild(pre);
    host.appendChild(section);
  }
  async function main(host) {
    const firstRound = /* @__PURE__ */ new Map();
    for (const call2 of BASE_CALLS) {
      const outcome = await invokeOne2(call2);
      if (outcome.kind === "receipt") {
        firstRound.set(call2.name, outcome.raw);
      }
      renderSection7(host, call2.name, outcome);
    }
    for (const dep of resolveDependentCalls(firstRound)) {
      const outcome = dep.skip === null ? await invokeOne2(dep.call) : { kind: "skipped", reason: dep.skip };
      renderSection7(host, dep.call.name, outcome);
    }
  }
  function mountShell(root2) {
    const header = document.createElement("header");
    header.className = "stock-header";
    const title = document.createElement("h1");
    title.textContent = "\u80A1\u7968\u63D2\u4EF6 \xB7 \u6570\u636E\u5207\u7247";
    header.appendChild(title);
    const nav = document.createElement("nav");
    nav.className = "stock-tabs";
    const dataHost = document.createElement("div");
    dataHost.className = "stock-view";
    const crossHost = document.createElement("div");
    crossHost.className = "stock-view";
    crossHost.hidden = true;
    const portfolioHost = document.createElement("div");
    portfolioHost.className = "stock-view";
    portfolioHost.hidden = true;
    const quantHost = document.createElement("div");
    quantHost.className = "stock-view";
    quantHost.hidden = true;
    const screenerHost = document.createElement("div");
    screenerHost.className = "stock-view";
    screenerHost.hidden = true;
    const ledgerHost = document.createElement("div");
    ledgerHost.className = "stock-view";
    ledgerHost.hidden = true;
    const diagnosisHost = document.createElement("div");
    diagnosisHost.className = "stock-view";
    diagnosisHost.hidden = true;
    const workspaceHost = document.createElement("div");
    workspaceHost.className = "stock-view";
    workspaceHost.hidden = true;
    const tabs = [
      { id: "data", label: "\u6570\u636E\u5207\u7247", host: dataHost },
      { id: "cross-market", label: "\u8DE8\u5E02\u573A\u884C\u60C5", host: crossHost },
      { id: "portfolio", label: "\u6A21\u62DF\u89C2\u5BDF", host: portfolioHost },
      { id: "quant", label: "\u91CF\u5316\u5B9E\u9A8C", host: quantHost },
      { id: "screener", label: "\u667A\u80FD\u9009\u80A1", host: screenerHost },
      { id: "paper-ledger", label: "\u6A21\u62DF\u7EC4\u5408\u8D26\u672C", host: ledgerHost },
      { id: "screenshot-diagnosis", label: "\u622A\u56FE\u8BCA\u65AD", host: diagnosisHost },
      { id: "workspace", label: "\u80A1\u7968\u5DE5\u4F5C\u533A", host: workspaceHost }
    ];
    const buttons = /* @__PURE__ */ new Map();
    let active = "data";
    let crossCleanup = null;
    let portfolioCleanup = null;
    let quantCleanup = null;
    let screenerCleanup = null;
    let ledgerCleanup = null;
    let diagnosisCleanup = null;
    let workspaceCleanup = null;
    function activate(id) {
      active = id;
      for (const tab of tabs) {
        const button = buttons.get(tab.id);
        if (button) {
          button.setAttribute("aria-selected", String(tab.id === id));
        }
        tab.host.hidden = tab.id !== id;
      }
      if (id === "cross-market" && crossCleanup === null) {
        crossCleanup = mountCrossMarket(crossHost, client);
      }
      if (id === "portfolio" && portfolioCleanup === null) {
        portfolioCleanup = mountPortfolio(portfolioHost, client);
      }
      if (id === "quant" && quantCleanup === null) {
        quantCleanup = mountQuant(quantHost, client);
      }
      if (id === "screener" && screenerCleanup === null) {
        screenerCleanup = mountScreener(screenerHost, client);
      }
      if (id === "paper-ledger" && ledgerCleanup === null) {
        ledgerCleanup = mountPaperLedger(ledgerHost, client);
      }
      if (id === "screenshot-diagnosis" && diagnosisCleanup === null) {
        diagnosisCleanup = mountScreenshotDiagnosis(diagnosisHost, client);
      }
      if (id === "workspace" && workspaceCleanup === null) {
        workspaceCleanup = mountWorkspace(workspaceHost, client);
      }
    }
    for (const tab of tabs) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = tab.label;
      button.addEventListener("click", () => activate(tab.id));
      buttons.set(tab.id, button);
      nav.appendChild(button);
    }
    root2.append(
      header,
      nav,
      dataHost,
      crossHost,
      portfolioHost,
      quantHost,
      screenerHost,
      ledgerHost,
      diagnosisHost,
      workspaceHost
    );
    activate(active);
    return () => {
      crossCleanup?.();
      portfolioCleanup?.();
      quantCleanup?.();
      screenerCleanup?.();
      ledgerCleanup?.();
      diagnosisCleanup?.();
      workspaceCleanup?.();
    };
  }
  var root = document.getElementById("root");
  var cleanupShell = null;
  if (root) {
    cleanupShell = mountShell(root);
    void main(root.querySelector(".stock-view") ?? root);
  }
  window.addEventListener("beforeunload", () => {
    cleanupShell?.();
    client.dispose();
  });
})();
