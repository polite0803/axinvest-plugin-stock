// B2 动态验证：在 jsdom 里加载构建出的 bundle.js，mock 宿主 postMessage。
// 两个场景各跑一遍 JSDOM：
//   ①有数据：list/weights 回执带真实行 ⇒ 断言三条级联命令的入参取自真实回执
//     （generatedAt/period/strategyId 非空且逐字等于源值），并断言全帧无空串入参；
//   ②无数据：list=[]、weights={} ⇒ 断言三条级联命令零帧发出、渲染「未发调用」，
//     与「本环境不提供该数据」（真实空回执）两种文案不得混淆。
// 公共断言：入口发且仅发 1 帧 skill:ready；10 条命令全部经 plugin_execute_command 通道；
// 有数据场景渲染满 10 个 section；bundle 含 beforeunload+dispose 卸载钩子（源码级）。
// 本脚本不进插件产物（位于 src-web/__verify__/，不在 web/ 树内）。
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 与 esbuild 构建目标逐字同源：验证必须读当前 bundle，不能读已装到宿主侧的旧产物。
const bundlePath = path.resolve(__dirname, "../../web/pages/bundle.js");
const bundle = fs.readFileSync(bundlePath, "utf8");

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log("  PASS " + msg);
  } else {
    failures += 1;
    console.log("  FAIL " + msg);
  }
}

/**
 * 跑一个场景。receiptFor(frame) 返回宿主 plugin_execute_command 的回执
 * （JSON 文本字符串，与 plugin.rs 的 Result<String,String> 同形）。
 */
async function runScenario(name, receiptFor) {
  console.log(`\n=== 场景：${name} ===`);
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { runScripts: "outside-only", url: "http://localhost" },
  );
  const { window } = dom;

  // 捕获沙箱 -> 宿主的帧。jsdom 里 window.parent === window，覆盖 postMessage 后
  // bundle 发出的帧不会自动投递成 message 事件（真实浏览器会），故在这里手动模拟宿主：
  // 收到 rpc:request 就按 receiptFor 回投成功帧，source 设为宿主文档身份（= window.parent）。
  const posted = [];
  const hostWindow = window.parent; // 客户端的期望来源 = window.parent，回帧 source 必须同一对象
  window.parent.postMessage = (frame, targetOrigin) => {
    posted.push({ frame, targetOrigin });
    if (frame && frame.type === "rpc:request") {
      const response = {
        type: "rpc:response",
        callId: frame.callId,
        result: receiptFor(frame.args?.args?.name ?? ""),
      };
      setTimeout(() => {
        const event = new window.MessageEvent("message", { data: response });
        // source 是原型上的只读 getter，Object.assign 覆盖不了，必须 defineProperty。
        Object.defineProperty(event, "source", { value: hostWindow });
        window.dispatchEvent(event);
      }, 0);
    }
  };

  // 加载 bundle（顶层创建客户端 + announceReady + 触发 main）。
  window.eval(bundle);

  // 等待所有异步 RPC 结算（级联三条依赖第一轮回执，链路两轮 setTimeout 0）。
  await new Promise((resolve) => setTimeout(resolve, 300));

  return { posted, root: window.document.getElementById("root"), window };
}

const READY_TEXT = "本环境不提供该数据";
const SKIP_TEXT = "未发调用";
const DETAIL_TS = "2026-11-17T02:00:00Z";

function assertCommon({ posted, root }, expectedNames) {
  check(
    posted.filter((p) => p.frame && p.frame.type === "skill:ready").length === 1,
    "顶层发出且仅发出 1 帧 skill:ready",
  );
  check(
    posted
      .filter((p) => p.frame && p.frame.type === "skill:ready")
      .every((p) => p.targetOrigin === "*"),
    "ready 帧 targetOrigin 恒为 '*'（沙箱 opaque origin 唯一可行值）",
  );
  const reqFrames = posted.filter((p) => p.frame && p.frame.type === "rpc:request");
  const names = reqFrames.map((p) => p.frame.args?.args?.name);
  for (const name of expectedNames) {
    check(names.includes(name), `发出的命令包含 ${name}`);
  }
  check(
    reqFrames.every((p) => p.frame.args?.command === "plugin_execute_command"),
    "全部 rpc:request 的 envelope.command 都是 plugin_execute_command（走对通道）",
  );
  check(
    root.querySelectorAll("section").length === 10,
    `渲染 10 个 section（实际 ${root.querySelectorAll("section").length}）`,
  );
  return reqFrames;
}

/** 找到内部 Tab 按钮；cross-market 是 T3 新增的第二视图。 */
function findTabButton(root, label) {
  return Array.from(root.querySelectorAll("button")).find((b) => b.textContent === label);
}

/** T3 跨市场切片：点击第二 Tab 后四条只读命令各发一帧，四区独立渲染。 */
async function assertCrossMarket({ posted, root, window }, scenarioName) {
  console.log(`  -- T3 跨市场切片：${scenarioName} --`);
  const before = posted.filter((p) => p.frame?.type === "rpc:request").length;
  const button = findTabButton(root, "跨市场行情");
  check(!!button, "内部 Tab「跨市场行情」存在");
  button?.click();
  // 四个区并发发帧 + jsdom 回调；等两轮宏任务足够收敛。
  await new Promise((resolve) => setTimeout(resolve, 50));
  const newFrames = posted
    .filter((p) => p.frame?.type === "rpc:request")
    .slice(before);
  const names = newFrames.map((p) => p.frame.args?.args?.name);
  for (const name of [
    "stock_get_international_stock_quote",
    "stock_get_international_stock_kline",
    "stock_get_benchmark_kline",
    "stock_get_forex_kline",
  ]) {
    check(names.includes(name), `跨市场点击后发出 ${name}`);
  }
  check(
    newFrames.every((p) => p.frame.args?.command === "plugin_execute_command"),
    "跨市场四条命令全部走 plugin_execute_command 通道",
  );
  const klineFrame = newFrames.find((p) => p.frame.args?.args?.name === "stock_get_international_stock_kline");
  check(
    klineFrame?.frame.args?.args?.input?.stockCode === "AAPL"
      && klineFrame?.frame.args?.args?.input?.period === "daily"
      && klineFrame?.frame.args?.args?.input?.limit === 120,
    `跨市场 K 线入参齐备且非空串（实际 ${JSON.stringify(klineFrame?.frame.args?.args?.input)}）`,
  );
  check(
    window.document.querySelectorAll(".x-section").length === 4,
    `跨市场渲染 4 个取数区（实际 ${window.document.querySelectorAll(".x-section").length}）`,
  );
  return newFrames;
}

/** T3 模拟观察切片：点击第三 Tab 后只发一条组合看板命令，四态与表格/图表分别渲染。 */
async function assertPortfolio({ posted, root }, scenarioName) {
  console.log(`  -- T3 模拟观察切片：${scenarioName} --`);
  const before = posted.filter((p) => p.frame?.type === "rpc:request").length;
  const button = findTabButton(root, "模拟观察");
  check(!!button, "内部 Tab「模拟观察」存在");
  button?.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const newFrames = posted
    .filter((p) => p.frame?.type === "rpc:request")
    .slice(before);
  check(
    newFrames.length === 1 && newFrames[0].frame.args?.args?.name === "stock_get_portfolio_dashboard",
    `只发出一条 stock_get_portfolio_dashboard（实际 ${JSON.stringify(newFrames.map((p) => p.frame?.args?.args?.name))}）`,
  );
  check(
    newFrames.every((p) => p.frame.args?.command === "plugin_execute_command"),
    "组合看板命令走 plugin_execute_command 通道",
  );
  const pTab = Array.from(root.querySelectorAll(".stock-view")).find((v) => !v.hidden && v.querySelector(".p-host"));
  check(!!pTab, "模拟观察视图被激活");
  check(pTab?.querySelectorAll(".p-card").length === 8, `渲染 8 张汇总卡（实际 ${pTab?.querySelectorAll(".p-card").length}）`);
  check(pTab?.querySelectorAll(".p-table tbody tr").length === 1, "持仓表渲染 1 行");
  check(pTab?.querySelectorAll(".p-sector").length === 2, "行业暴露渲染 2 行");
  check(pTab?.querySelectorAll(".p-stress-item").length === 3, "压力测试渲染 3 个场景");
  return newFrames;
}

/** T3 量化切片：策略列表默认加载，另两条命令必须带回非空的 camelCase 入参。 */
async function assertQuant({ posted, root }) {
  console.log("  -- T3 量化切片：三条已声明只读命令 --");
  const before = posted.filter((p) => p.frame?.type === "rpc:request").length;
  const button = findTabButton(root, "量化实验");
  check(!!button, "内部 Tab「量化实验」存在");
  button?.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  let frames = posted.filter((p) => p.frame?.type === "rpc:request").slice(before);
  check(
    frames.length === 1 && frames[0].frame.args?.args?.name === "stock_quant_strategies_list",
    `只发出一条 stock_quant_strategies_list（实际 ${JSON.stringify(frames.map((p) => p.frame?.args?.args?.name))}）`,
  );
  const qTab = Array.from(root.querySelectorAll(".stock-view")).find((v) => !v.hidden && v.querySelector(".q-strategies"));
  check(!!qTab, "量化视图被激活");
  check(qTab?.querySelectorAll(".p-table tbody tr").length === 2, "策略表渲染 2 行");
  check(
    !!qTab && Array.from(qTab.querySelectorAll("p")).some((p) => p.textContent?.includes("请填写")),
    "空运行 ID 显示显式跳过态（未发调用）",
  );

  const inputs = qTab ? Array.from(qTab.querySelectorAll("input")) : [];
  const runInput = inputs[0];
  const compareInput = inputs[1];
  if (runInput && compareInput) {
    runInput.value = "r1";
    compareInput.value = "r1, r2";
    const beforeRun = posted.filter((p) => p.frame?.type === "rpc:request").length;
    findTabButton(root, "查运行详情")?.click();
    findTabButton(root, "对比指标")?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    frames = posted.filter((p) => p.frame?.type === "rpc:request").slice(beforeRun);
    const runFrame = frames.find((p) => p.frame.args?.args?.name === "stock_quant_run_get");
    const compareFrame = frames.find((p) => p.frame.args?.args?.name === "stock_quant_metrics_compare");
    check(runFrame?.frame.args?.args?.input?.runId === "r1", `运行详情入参 runId=r1（实际 ${JSON.stringify(runFrame?.frame.args?.args?.input)}）`);
    check(
      JSON.stringify(compareFrame?.frame.args?.args?.input?.runIds) === JSON.stringify(["r1", "r2"]),
      `指标对比入参 runIds=["r1","r2"]（实际 ${JSON.stringify(compareFrame?.frame.args?.args?.input)}）`,
    );
    check(
      frames.every((p) => p.frame.args?.command === "plugin_execute_command"),
      "量化三条命令全部走 plugin_execute_command 通道",
    );
  } else {
    check(false, "量化视图有两个输入字段");
  }
}

/** T3 选股切片：六条独立读数并发 + 从热股榜代码级联一条决策摘要。 */
async function assertScreener({ posted, root }) {
  console.log("  -- T3 智能选股切片：六条读数 + 一条级联 --");
  const before = posted.filter((p) => p.frame?.type === "rpc:request").length;
  const button = findTabButton(root, "智能选股");
  check(!!button, "内部 Tab「智能选股」存在");
  button?.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const frames = posted.filter((p) => p.frame?.type === "rpc:request").slice(before);
  const names = frames.map((p) => p.frame.args?.args?.name);
  for (const name of [
    "stock_get_reco_pool_batch",
    "stock_get_reco_board_scope",
    "stock_get_hot_stocks",
    "stock_get_limit_up_pool",
    "stock_get_market_dragon_tiger",
    "stock_list_reco_history",
    "stock_get_latest_analyses_for_stocks",
  ]) {
    check(names.includes(name), `选股点击后发出 ${name}`);
  }
  check(
    frames.every((p) => p.frame.args?.command === "plugin_execute_command"),
    "选股七条命令全部走 plugin_execute_command 通道",
  );
  const detailFrame = frames.find((p) => p.frame.args?.args?.name === "stock_get_latest_analyses_for_stocks");
  check(
    JSON.stringify(detailFrame?.frame.args?.args?.input?.stockCodes) === JSON.stringify(["600519", "000858"]),
    `级联 stockCodes 取自热股榜真实回执（实际 ${JSON.stringify(detailFrame?.frame.args?.args?.input)}）`,
  );
  const sTab = Array.from(root.querySelectorAll(".stock-view")).find((v) => !v.hidden && v.querySelector("button")?.textContent === "刷新选股数据");
  check(!!sTab, "智能选股视图被激活");
  check(sTab?.querySelectorAll(".x-section").length === 7, `渲染 7 个取数区（实际 ${sTab?.querySelectorAll(".x-section").length}）`);
  check(sTab?.querySelectorAll(".p-card").length === 6, `候选池摘要渲染 6 张卡（实际 ${sTab?.querySelectorAll(".p-card").length}）`);
}

/** G2 模拟组合账本：默认 active 详情 + 详情/创建/归档三条写读级联。 */
async function assertPaperLedger({ posted, root }) {
  console.log("  -- G2 模拟组合账本切片：active 详情 + 级联 --");
  const before = posted.filter((p) => p.frame?.type === "rpc:request").length;
  const button = findTabButton(root, "模拟组合账本");
  check(!!button, "内部 Tab「模拟组合账本」存在");
  button?.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const firstFrames = posted.filter((p) => p.frame?.type === "rpc:request").slice(before);
  check(
    firstFrames.length === 1
      && firstFrames[0].frame.args?.args?.name === "paper_portfolio_list_active_details",
    `点击后只发一条 active 详情命令（实际 ${JSON.stringify(firstFrames.map((p) => p.frame.args?.args?.name))}）`,
  );
  const tab = Array.from(root.querySelectorAll(".stock-view")).find((v) => !v.hidden && v.querySelector(".l-host"));
  check(!!tab, "模拟组合账本视图被激活");
  check(tab?.querySelectorAll(".l-row").length === 2, `组合列表渲染 2 行（实际 ${tab?.querySelectorAll(".l-row").length}）`);

  const tabButton = (label) => Array.from(tab?.querySelectorAll("button") ?? []).find((b) => b.textContent === label);
  let createFrames = [];

  const beforeDetail = posted.filter((p) => p.frame?.type === "rpc:request").length;
  tabButton("组合详情")?.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const detailFrames = posted.filter((p) => p.frame?.type === "rpc:request").slice(beforeDetail);
  const detailFrame = detailFrames.find((p) => p.frame.args?.args?.name === "paper_portfolio_get");
  check(
    detailFrame?.frame.args?.args?.input?.portfolioId === "p-1",
    `详情入参 portfolioId 取自 active 回执（实际 ${JSON.stringify(detailFrame?.frame.args?.args?.input)}）`,
  );
  check(tab?.querySelectorAll(".l-detail table tr").length === 2, "详情持仓表渲染 2 行");

  const inputs = tab ? Array.from(tab.querySelectorAll("input")) : [];
  if (inputs.length >= 2) {
    inputs[0].value = "新观察组合";
    inputs[1].value = "事件级联";
    const beforeCreate = posted.filter((p) => p.frame?.type === "rpc:request").length;
    tabButton("创建组合")?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    createFrames = posted.filter((p) => p.frame?.type === "rpc:request").slice(beforeCreate);
    const createFrame = createFrames.find((p) => p.frame.args?.args?.name === "paper_portfolio_create");
    check(
      createFrame?.frame.args?.args?.input?.name === "新观察组合"
        && createFrame?.frame.args?.args?.input?.sourceEvent === "事件级联",
      `创建入参 name/sourceEvent 非空（实际 ${JSON.stringify(createFrame?.frame.args?.args?.input)}）`,
    );
  } else {
    check(false, "账本视图有名称与来源事件两个输入字段");
  }

  const beforeArchive = posted.filter((p) => p.frame?.type === "rpc:request").length;
  const archiveButtons = Array.from(tab?.querySelectorAll("button") ?? []).filter((b) => b.textContent === "归档组合");
  archiveButtons[1]?.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const archiveFrames = posted.filter((p) => p.frame?.type === "rpc:request").slice(beforeArchive);
  const archiveFrame = archiveFrames.find((p) => p.frame.args?.args?.name === "paper_portfolio_archive");
  check(
    archiveFrame?.frame.args?.args?.input?.portfolioId === "p-2",
    `归档入参 portfolioId 取自第二行回执（实际 ${JSON.stringify(archiveFrame?.frame.args?.args?.input)}）`,
  );

  const allFrames = [...firstFrames, ...detailFrames, ...createFrames, ...archiveFrames];
  check(
    allFrames.every((p) => p.frame.args?.command === "plugin_execute_command"),
    "账本四条命令全部走 plugin_execute_command 通道",
  );
}

/** G6 截图诊断：默认最近列表 + 详情/转组合/归档级联；空表单不发帧。 */
async function assertScreenshotDiagnosis({ posted, root }) {
  console.log("  -- G6 截图诊断切片：最近列表 + 级联 --");
  const before = posted.filter((p) => p.frame?.type === "rpc:request").length;
  const button = findTabButton(root, "截图诊断");
  check(!!button, "内部 Tab「截图诊断」存在");
  button?.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const firstFrames = posted.filter((p) => p.frame?.type === "rpc:request").slice(before);
  check(
    firstFrames.length === 1
      && firstFrames[0].frame.args?.args?.name === "screenshot_diagnosis_list_recent"
      && firstFrames[0].frame.args?.args?.input?.limit === 20,
    `点击后只发一条最近诊断命令（实际 ${JSON.stringify(firstFrames.map((p) => p.frame.args?.args?.name))}）`,
  );
  const tab = Array.from(root.querySelectorAll(".stock-view")).find((v) => !v.hidden && v.querySelector(".d-host"));
  check(!!tab, "截图诊断视图被激活");
  check(tab?.querySelectorAll(".d-row").length === 2, `诊断列表渲染 2 行（实际 ${tab?.querySelectorAll(".d-row").length}）`);

  const tabButton = (label) => Array.from(tab?.querySelectorAll("button") ?? []).find((b) => b.textContent === label);

  const beforeDetail = posted.filter((p) => p.frame?.type === "rpc:request").length;
  tabButton("诊断详情")?.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const detailFrames = posted.filter((p) => p.frame?.type === "rpc:request").slice(beforeDetail);
  const detailFrame = detailFrames.find((p) => p.frame.args?.args?.name === "screenshot_diagnosis_get");
  check(
    detailFrame?.frame.args?.args?.input?.diagnosisId === "d-1",
    `详情入参 diagnosisId 取自列表回执（实际 ${JSON.stringify(detailFrame?.frame.args?.args?.input)}）`,
  );
  check(tab?.querySelectorAll(".d-detail pre").length === 1, "详情区渲染结构化持仓");

  const inputs = tab ? Array.from(tab.querySelectorAll("input")) : [];
  // 前三个是上传表单（file / provider / model），后两个是转组合表单。
  if (inputs.length >= 5) {
    inputs[3].value = "截图转组合";
    inputs[4].value = "截图事件";
    const beforeConvert = posted.filter((p) => p.frame?.type === "rpc:request").length;
    tabButton("转为组合")?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const convertFrames = posted.filter((p) => p.frame?.type === "rpc:request").slice(beforeConvert);
    const convertFrame = convertFrames.find((p) => p.frame.args?.args?.name === "screenshot_diagnosis_to_paper_portfolio");
    check(
      convertFrame?.frame.args?.args?.input?.diagnosisId === "d-1"
        && convertFrame?.frame.args?.args?.input?.name === "截图转组合"
        && convertFrame?.frame.args?.args?.input?.sourceEvent === "截图事件",
      `转组合入参齐备（实际 ${JSON.stringify(convertFrame?.frame.args?.args?.input)}）`,
    );
  } else {
    check(false, "诊断视图有五个输入字段（上传三项 + 转组合两项）");
  }

  const beforeArchive = posted.filter((p) => p.frame?.type === "rpc:request").length;
  tabButton("归档诊断")?.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const archiveFrames = posted.filter((p) => p.frame?.type === "rpc:request").slice(beforeArchive);
  const archiveFrame = archiveFrames.find((p) => p.frame.args?.args?.name === "screenshot_diagnosis_archive");
  check(
    archiveFrame?.frame.args?.args?.input?.diagnosisId === "d-1",
    `归档入参 diagnosisId 取自列表回执（实际 ${JSON.stringify(archiveFrame?.frame.args?.args?.input)}）`,
  );

  const beforeEmptyUpload = posted.filter((p) => p.frame?.type === "rpc:request").length;
  tabButton("上传并诊断")?.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  check(
    posted.filter((p) => p.frame?.type === "rpc:request").length === beforeEmptyUpload,
    "上传表单未填 provider/model 时零帧发出（不发空串）",
  );

  const allFrames = [...firstFrames, ...detailFrames, ...archiveFrames];
  check(
    allFrames.every((p) => p.frame.args?.command === "plugin_execute_command"),
    "诊断命令全部走 plugin_execute_command 通道",
  );
}

/** T3 股票工作区：六视图数据面 + 对比视图级联 + 空代码零帧。 */
async function assertWorkspace({ posted, root }) {
  console.log("  -- T3 股票工作区切片：六视图数据面 --");
  const before = posted.filter((p) => p.frame?.type === "rpc:request").length;
  const button = findTabButton(root, "股票工作区");
  check(!!button, "内部 Tab「股票工作区」存在");
  button?.click();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const first = posted.filter((p) => p.frame?.type === "rpc:request").slice(before);
  const firstNames = first.map((p) => p.frame.args?.args?.name);
  check(
    firstNames.includes("stock_get_quote") && firstNames.includes("stock_get_financials"),
    `分析视图发出行情 + 财务两条命令（实际 ${JSON.stringify(firstNames)}）`,
  );
  check(
    first.every((p) => p.frame.args?.args?.input?.stockCode === "600519"),
    "分析视图 stockCode 取自输入框默认值",
  );
  const wTab = Array.from(root.querySelectorAll(".stock-view")).find((v) => !v.hidden && v.querySelector("input"));
  check(!!wTab, "工作区视图被激活");

  const viewButton = (label) => Array.from(root.querySelectorAll(".w-tabs button")).find((b) => b.textContent === label);
  const framesSince = (n) => posted.filter((p) => p.frame?.type === "rpc:request").slice(n);

  const beforeMonitor = posted.filter((p) => p.frame?.type === "rpc:request").length;
  viewButton("监控")?.click();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const monitorNames = framesSince(beforeMonitor).map((p) => p.frame.args?.args?.name);
  check(
    monitorNames.includes("stock_list_portfolio") && monitorNames.includes("stock_list_price_alerts"),
    `监控视图发出持仓 + 告警两条命令（实际 ${JSON.stringify(monitorNames)}）`,
  );

  const beforeCompare = posted.filter((p) => p.frame?.type === "rpc:request").length;
  viewButton("对比")?.click();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const compareFrames = framesSince(beforeCompare);
  const listFrame = compareFrames.find((p) => p.frame.args?.args?.name === "stock_list_stock_analyses");
  const detailFrame = compareFrames.find((p) => p.frame.args?.args?.name === "stock_get_stock_analysis");
  check(
    listFrame?.frame.args?.args?.input?.limit === 5 && listFrame?.frame.args?.args?.input?.offset === 0,
    `分析列表入参 limit/offset 齐备（实际 ${JSON.stringify(listFrame?.frame.args?.args?.input)}）`,
  );
  check(
    detailFrame?.frame.args?.args?.input?.analysisId === "a-1",
    `详情入参 analysisId 取自列表回执（实际 ${JSON.stringify(detailFrame?.frame.args?.args?.input)}）`,
  );

  const codeInput = wTab ? Array.from(wTab.querySelectorAll("input"))[0] : null;
  if (codeInput) {
    codeInput.value = "";
    const beforeEmpty = posted.filter((p) => p.frame?.type === "rpc:request").length;
    viewButton("复盘")?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    check(
      framesSince(beforeEmpty).length === 0,
      "股票代码为空时复盘视图零帧发出（不发空串）",
    );
    check(
      Array.from(root.querySelectorAll("pre")).some((p) => (p.textContent ?? "").includes("未发调用")),
      "空代码显示显式跳过态",
    );
  } else {
    check(false, "工作区视图有股票代码输入框");
  }

  check(
    posted.filter((p) => p.frame?.type === "rpc:request").slice(before)
      .every((p) => p.frame.args?.command === "plugin_execute_command"),
    "工作区命令全部走 plugin_execute_command 通道",
  );
}

// ── 场景一：库里有真实荐股记录 + 权重台账 ──
const withData = await runScenario("有数据（list 1 行 mid + weights {trend_mid,capital_long}）", (name) => {
  if (name === "stock_list_reco_history") {
    return JSON.stringify([
      { generatedAt: DETAIL_TS, period: "mid", stockCount: 3, styles: "trend", createdAt: DETAIL_TS },
    ]);
  }
  if (name === "stock_get_reco_strategy_weights") {
    return JSON.stringify({ trend_mid: 0.8, capital_long: 1.0 });
  }
  if (name === "stock_get_reco_pool_batch") {
    return JSON.stringify({
      generatedAt: DETAIL_TS, period: "mid", stockCount: 2,
      degraded: false, purpose: "reco", hasSnapshot: true,
    });
  }
  if (name === "stock_get_reco_board_scope") {
    return JSON.stringify(["sh_main", "sz_main"]);
  }
  if (name === "stock_get_hot_stocks") {
    return JSON.stringify([
      { stockCode: "600519", name: "贵州茅台" },
      { stockCode: "000858", name: "五粮液" },
    ]);
  }
  if (name === "stock_get_limit_up_pool") {
    return JSON.stringify([{ stockCode: "000001", name: "平安银行" }]);
  }
  if (name === "stock_get_market_dragon_tiger") {
    return JSON.stringify([{ stockCode: "600036", name: "招商银行" }]);
  }
  if (name === "stock_get_latest_analyses_for_stocks") {
    return JSON.stringify([{ stockCode: "600519", decision: "buy" }]);
  }
  if (name === "stock_quant_strategies_list") {
    return JSON.stringify([
      { id: "s1", name: "均线交叉", version: "1.0", description: "MA5/MA20" },
      { id: "s2", name: "动量突破", version: "2.1", description: "20 日新高" },
    ]);
  }
  if (name === "stock_quant_run_get") {
    return JSON.stringify({ run: { id: "r1", status: "completed" }, strategyName: "均线交叉" });
  }
  if (name === "stock_quant_metrics_compare") {
    return JSON.stringify({ runs: [], bestBy: { sharpeRatio: "r1" } });
  }
  if (name === "stock_get_portfolio_dashboard") {
    return JSON.stringify({
      totalMarketValue: 160000,
      totalPnl: 10000,
      totalPnlPct: 6.67,
      riskLevel: "中",
      diversificationScore: 72,
      topConcentrationPct: 62.5,
      unpricedPositions: 1,
      concentrationWarning: null,
      positions: [{
        code: "600519", name: "贵州茅台", quantity: 100,
        costBasis: 1500, lastPrice: 1600, marketValue: 160000, unrealizedPnl: 10000,
      }],
      sectorExposure: { 白酒: 62.5, 食品: 37.5 },
      stressTest: { m10: { lossPct: -10 }, m20: null, blackSwan: null },
      asOfDate: null,
      isHistorical: false,
    });
  }
  if (name === "paper_portfolio_list_active_details") {
    return JSON.stringify([
      {
        id: "p-1", name: "AI 观察", sourceEvent: "英伟达隔夜大跌", status: "active",
        createdAt: 1700000000000,
        positions: [{ id: "pos-1", symbol: "600519" }],
        summary: { totalMarketValue: 160000, totalUnrealizedPnl: 10000 },
      },
      {
        id: "p-2", name: "防御观察", sourceEvent: "红利风格切换", status: "active",
        createdAt: 1700000001000,
        positions: [{ id: "pos-2", symbol: "600036" }],
        summary: { totalMarketValue: 80000, totalUnrealizedPnl: 2000 },
      },
    ]);
  }
  if (name === "paper_portfolio_get") {
    return JSON.stringify({
      id: "p-1", name: "AI 观察", sourceEvent: "英伟达隔夜大跌", status: "active",
      positions: [
        { symbol: "600519", quantity: 100, entryPrice: 1500, currentPrice: 1600, unrealizedPnl: 10000 },
        { symbol: "000858", quantity: 50, entryPrice: 140, currentPrice: 150, unrealizedPnl: 500 },
      ],
      summary: { totalMarketValue: 160000, totalUnrealizedPnl: 10000 },
    });
  }
  if (name === "paper_portfolio_create") {
    return JSON.stringify({ id: "p-3", name: "新观察组合", status: "active", positions: [], summary: {} });
  }
  if (name === "paper_portfolio_archive") {
    return JSON.stringify({ id: "p-2", status: "archived" });
  }
  if (name === "screenshot_diagnosis_list_recent") {
    return JSON.stringify([
      {
        id: "d-1", sourceApp: "同花顺", status: "active", totalMarketValue: 50000,
        narrative: "集中度偏高", positionsJson: "[{\"code\":\"600519\",\"name\":\"贵州茅台\",\"qty\":100,\"marketValue\":50000}]",
        createdAt: 1700000000000,
      },
      {
        id: "d-2", sourceApp: "雪球", status: "active", totalMarketValue: 30000,
        narrative: "防御仓位为主", positionsJson: "[]", createdAt: 1700000001000,
      },
    ]);
  }
  if (name === "screenshot_diagnosis_get") {
    return JSON.stringify({
      id: "d-1", sourceApp: "同花顺", status: "active", totalMarketValue: 50000,
      narrative: "集中度偏高，建议分散",
      positionsJson: "[{\"code\":\"600519\",\"name\":\"贵州茅台\",\"qty\":100,\"marketValue\":50000},{\"code\":\"000858\",\"name\":\"五粮液\",\"qty\":50,\"marketValue\":30000}]",
      recommendedActions: "[\"分散持仓\"]", createdAt: 1700000000000,
    });
  }
  if (name === "screenshot_diagnosis_archive") {
    return JSON.stringify({ id: "d-1", status: "archived" });
  }
  if (name === "screenshot_diagnosis_to_paper_portfolio") {
    return JSON.stringify({ id: "p-4", name: "截图转组合", status: "active" });
  }
  if (name === "screenshot_diagnosis_create_from_image") {
    return JSON.stringify({ id: "d-3", status: "active", narrative: "新诊断", positionsJson: "[]" });
  }
  if (name === "stock_get_quote") {
    return JSON.stringify({ stockCode: "600519", name: "贵州茅台", lastPrice: 1600, changePct: 1.2 });
  }
  if (name === "stock_get_financials") {
    return JSON.stringify({ stockCode: "600519", revenue: 150000000000, netProfit: 70000000000 });
  }
  if (name === "stock_list_portfolio") {
    return JSON.stringify([{ symbol: "600519", quantity: 100, marketValue: 160000 }]);
  }
  if (name === "stock_list_price_alerts") {
    return JSON.stringify([{ id: "alert-1", stockCode: "600519", targetPrice: 1700 }]);
  }
  if (name === "stock_list_stock_analyses") {
    return JSON.stringify([{ id: "a-1", stockCode: "600519", decision: "buy", createdAt: DETAIL_TS }]);
  }
  if (name === "stock_get_stock_analysis") {
    return JSON.stringify({ id: "a-1", stockCode: "600519", decision: "buy", narrative: "基本面稳健" });
  }
  return JSON.stringify(null);
});

{
  const reqFrames = assertCommon(withData, [
    "stock_reflection_stats",
    "stock_reco_ic_stats",
    "stock_get_reco_strategy_weights",
    "stock_get_market_status",
    "stock_get_vendor_fallback_log",
    "stock_list_reco_history",
    "stock_list_stock_tools",
    "stock_get_reco_detail",
    "stock_get_cached_recommendation",
    "stock_get_reco_signal_history",
  ]);
  const frameOf = (name) => reqFrames.find((p) => p.frame.args?.args?.name === name)?.frame;

  console.log("  -- 级联入参取自真实回执 --");
  const detailInput = frameOf("stock_get_reco_detail")?.args?.args?.input;
  check(
    detailInput?.generatedAt === DETAIL_TS,
    `stock_get_reco_detail 的 generatedAt 取自 list 首行（实际 ${JSON.stringify(detailInput)}）`,
  );
  const cachedInput = frameOf("stock_get_cached_recommendation")?.args?.args?.input;
  check(
    cachedInput?.period === "mid",
    `stock_get_cached_recommendation 的 period 取自 list 首行档位（实际 ${JSON.stringify(cachedInput)}）`,
  );
  const signalInput = frameOf("stock_get_reco_signal_history")?.args?.args?.input;
  check(
    signalInput?.strategyId === "trend",
    `stock_get_reco_signal_history 的 strategyId 切自 weights 键 trend_mid（实际 ${JSON.stringify(signalInput)}）`,
  );

  console.log("  -- 全帧无空串入参（红灯回归断言）--");
  const emptyInputFrames = reqFrames.filter((p) => {
    const input = p.frame.args?.args?.input;
    if (input === undefined || input === null) { return false; }
    return Object.values(input).some((v) => v === "");
  });
  check(emptyInputFrames.length === 0, `没有任何一帧携带空串入参（实际 ${emptyInputFrames.length} 帧）`);

  const preTexts = Array.from(withData.root.querySelectorAll("pre")).map((pre) => pre.textContent ?? "");
  check(!preTexts.some((t) => t.includes(SKIP_TEXT)), "有数据场景不出现「未发调用」");
  await assertCrossMarket(withData, "行情回执为 JSON 文本");
  await assertPortfolio(withData, "组合看板回执为 JSON 文本");
  await assertQuant(withData);
  await assertScreener(withData);
  await assertPaperLedger(withData);
  await assertScreenshotDiagnosis(withData);
  await assertWorkspace(withData);
}

// ── 场景二：库里无记录、权重台账为空 ──
const noData = await runScenario("无数据（list=[]、weights={}）", (name) => {
  if (name === "stock_list_reco_history") {
    return JSON.stringify([]);
  }
  if (name === "stock_get_reco_strategy_weights") {
    return JSON.stringify({});
  }
  return JSON.stringify(null);
});

{
  const reqFrames = assertCommon(noData, [
    "stock_reflection_stats",
    "stock_reco_ic_stats",
    "stock_get_reco_strategy_weights",
    "stock_get_market_status",
    "stock_get_vendor_fallback_log",
    "stock_list_reco_history",
    "stock_list_stock_tools",
  ]);
  const names = reqFrames.map((p) => p.frame.args?.args?.name);
  for (const name of ["stock_get_reco_detail", "stock_get_cached_recommendation", "stock_get_reco_signal_history"]) {
    check(!names.includes(name), `无数据场景不发出 ${name}（零帧）`);
  }

  const preTexts = Array.from(noData.root.querySelectorAll("pre")).map((pre) => pre.textContent ?? "");
  const skipCount = preTexts.filter((t) => t.includes(SKIP_TEXT)).length;
  check(skipCount === 3, `恰好 3 个 section 显示「${SKIP_TEXT}」+原因（实际 ${skipCount}）`);
  const emptyCount = preTexts.filter((t) => t.includes(READY_TEXT)).length;
  check(emptyCount === 7, `7 条无参命令显示「${READY_TEXT}」（实际 ${emptyCount}）`);
}

console.log("\n=== ④ 卸载钩子 ===");
check(bundle.includes("beforeunload") && bundle.includes("dispose"), "bundle 含 beforeunload 卸载钩子并调 dispose()");

console.log(`\n结果：${failures === 0 ? "全部通过" : failures + " 项失败"}`);
process.exit(failures === 0 ? 0 : 1);
