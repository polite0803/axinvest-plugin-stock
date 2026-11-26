// SPDX-License-Identifier: AGPL-3.0-only
//
// T3 原生 bundle 视图：截图持仓诊断。
//
// 八条 `screenshot_diagnosis_*` 命名命令已在 stock 插件清单声明，上传后的 VLM/LLM 解析
// 经 `stock.analysis` 接缝落到宿主无 State 核心；本模块只负责选择文件、渲染回执与
// 级联交互，不复制 OCR / 风险诊断算法（禁区 12）。
// 入参纪律：详情 / 归档 / 转组合的 diagnosisId 只从真实回执 id 取；上传的 providerId /
// modelId 必须由用户输入，缺值只提示、不发空串命令。

import type { AxAgentPluginClient } from "../vendor/sdk/pluginClientBridge";

const LIST_RECENT = "screenshot_diagnosis_list_recent";
const GET = "screenshot_diagnosis_get";
const ARCHIVE = "screenshot_diagnosis_archive";
const TO_PORTFOLIO = "screenshot_diagnosis_to_paper_portfolio";
const CREATE_FROM_IMAGE = "screenshot_diagnosis_create_from_image";

interface Diagnosis {
  id?: string;
  sourceApp?: string | null;
  status?: string;
  totalMarketValue?: number;
  narrative?: string;
  positionsJson?: string;
  recommendedActions?: string;
  createdAt?: number;
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

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

/** 详情区：结构化持仓 JSON 字符串解析后按行展示；解析失败按原文展示，不伪装成空表。 */
function detailContent(raw: unknown): HTMLElement {
  const value = parseJson(raw);
  const wrap = document.createElement("div");
  wrap.className = "d-detail";
  if (!isRecord(value)) {
    const p = document.createElement("p");
    p.className = "x-empty";
    p.textContent = "本环境不提供该数据";
    wrap.appendChild(p);
    return wrap;
  }
  const narrative = document.createElement("p");
  narrative.textContent = text(value.narrative);
  wrap.appendChild(narrative);
  const positions = parseJson(value.positionsJson);
  const rows = Array.isArray(positions) ? positions : [];
  const title = document.createElement("h3");
  title.textContent = `识别持仓（${rows.length}）`;
  wrap.appendChild(title);
  const pre = document.createElement("pre");
  pre.textContent = rows.length > 0
    ? rows.map((row) => isRecord(row)
      ? `${text(row.code)} ${text(row.name)} · 数量 ${numberText(row.qty)} · 市值 ${numberText(row.marketValue)}`
      : String(row)).join("\n")
    : "—";
  wrap.appendChild(pre);
  return wrap;
}

/**
 * 装载截图诊断页：默认拉最近 20 条；详情 / 归档 / 转组合按行级联，
 * 上传表单走 FileReader → base64 → 写命令。generation 防过期回包。
 */
export function mountScreenshotDiagnosis(root: HTMLElement, client: AxAgentPluginClient): () => void {
  const bar = document.createElement("div");
  bar.className = "x-form";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/png,image/jpeg";
  const providerInput = document.createElement("input");
  providerInput.type = "text";
  providerInput.placeholder = "视觉模型 provider id";
  const modelInput = document.createElement("input");
  modelInput.type = "text";
  modelInput.placeholder = "视觉模型 model id";
  const upload = document.createElement("button");
  upload.type = "button";
  upload.textContent = "上传并诊断";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "刷新诊断";
  bar.append(fileInput, providerInput, modelInput, upload, refresh);

  const listHost = document.createElement("div");
  listHost.className = "d-host";
  const detailHost = document.createElement("div");
  detailHost.className = "d-host";
  const actionHost = document.createElement("div");
  actionHost.className = "d-host";
  const convertName = document.createElement("input");
  convertName.type = "text";
  convertName.placeholder = "转组合名称";
  const convertEvent = document.createElement("input");
  convertEvent.type = "text";
  convertEvent.placeholder = "来源事件";
  actionHost.append(convertName, convertEvent);
  root.replaceChildren(bar, listHost, detailHost, actionHost);

  let disposed = false;
  let generation = 0;

  async function load(): Promise<void> {
    const round = ++generation;
    renderSection(listHost, "loading", "");
    try {
      const raw = await client.executeCommand({ name: LIST_RECENT, input: { limit: 20 } });
      if (disposed || round !== generation) {
        return;
      }
      const value = parseJson(raw);
      if (!Array.isArray(value) || value.length === 0) {
        renderSection(listHost, "empty", "暂无截图诊断");
        return;
      }
      const content = document.createElement("div");
      for (const row of value) {
        if (!isRecord(row)) {
          continue;
        }
        content.appendChild(diagnosisRow(row as Diagnosis));
      }
      renderSection(listHost, "ready", "", content);
    } catch (error) {
      if (disposed || round !== generation) {
        return;
      }
      renderSection(listHost, "error", errorMessage(error));
    }
  }

  function diagnosisRow(row: Diagnosis): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "d-row";
    const labels = [
      `来源：${text(row.sourceApp)}`,
      `状态：${text(row.status)}`,
      `总市值：${numberText(row.totalMarketValue)}`,
      `创建时间：${typeof row.createdAt === "number" ? String(row.createdAt) : "—"}`,
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
      hint.textContent = "回执缺 id，未发详情/归档/转组合调用";
      wrap.appendChild(hint);
      return wrap;
    }
    const detail = document.createElement("button");
    detail.type = "button";
    detail.textContent = "诊断详情";
    detail.addEventListener("click", () => void callById(GET, id, detailHost, {}));
    const archive = document.createElement("button");
    archive.type = "button";
    archive.textContent = "归档诊断";
    archive.addEventListener("click", () => void callById(ARCHIVE, id, listHost, {}));
    const convert = document.createElement("button");
    convert.type = "button";
    convert.textContent = "转为组合";
    convert.addEventListener("click", () => {
      const name = convertName.value.trim();
      const sourceEvent = convertEvent.value.trim();
      if (name === "" || sourceEvent === "") {
        renderSection(actionHost, "empty", "未发调用：请填写组合名称与来源事件");
        return;
      }
      void callById(TO_PORTFOLIO, id, actionHost, { name, sourceEvent });
    });
    wrap.append(detail, archive, convert);
    return wrap;
  }

  async function callById(
    name: string,
    diagnosisId: string,
    target: HTMLElement,
    extra: Record<string, unknown>,
  ): Promise<void> {
    if (disposed || diagnosisId === "") {
      return;
    }
    const round = ++generation;
    renderSection(target, "loading", "");
    try {
      const raw = await client.executeCommand({
        name,
        input: { diagnosisId, ...extra },
      });
      if (disposed || round !== generation) {
        return;
      }
      if (name === GET) {
        renderSection(target, "ready", "", detailContent(raw));
      } else {
        const result = parseJson(raw);
        const done = document.createElement("p");
        done.textContent = `已${name === ARCHIVE ? "归档" : "转为组合"}：${isRecord(result) ? text(result.id) : "完成"}`;
        renderSection(target, "ready", "", done);
        await load();
      }
    } catch (error) {
      if (disposed || round !== generation) {
        return;
      }
      renderSection(target, "error", errorMessage(error));
    }
  }

  function onUpload(): void {
    const providerId = providerInput.value.trim();
    const modelId = modelInput.value.trim();
    const file = fileInput.files?.[0];
    if (!file || providerId === "" || modelId === "") {
      renderSection(actionHost, "empty", "未发调用：请选择截图并填写 provider / model");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const imageBase64 = typeof reader.result === "string" ? reader.result : "";
      if (imageBase64 === "") {
        renderSection(actionHost, "empty", "未发调用：图片读取失败");
        return;
      }
      const round = ++generation;
      renderSection(actionHost, "loading", "");
      void client
        .executeCommand({
          name: CREATE_FROM_IMAGE,
          input: { imageBase64, sourceApp: "其他", providerId, modelId },
        })
        .then((raw) => {
          if (disposed || round !== generation) {
            return;
          }
          renderSection(actionHost, "ready", "", detailContent(raw));
          return load();
        })
        .catch((error: unknown) => {
          if (!disposed && round === generation) {
            renderSection(actionHost, "error", errorMessage(error));
          }
        });
    };
    reader.readAsDataURL(file);
  }

  const onRefresh = (): void => {
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
