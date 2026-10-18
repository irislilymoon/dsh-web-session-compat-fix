#!/usr/bin/env node
/**
 * dsh web（alpha2）读取 desktop（rc2）会话的兼容修复工具。
 * 一般直接双击同目录的三个 .cmd，不需要手动运行本文件。
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as zlib from "node:zlib";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BACKUP_ROOT = join(SCRIPT_DIR, "backups");
const REQUIRED_TYPES = ["job/registered", "job/settled"];
const TARGETS = [
  "node_modules/@deepseek-ai/dsh-session/lib/index.js",
  "node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js",
  "node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js",
];
const SET_RE = /(KNOWN_SESSION_EVENT_TYPES\s*=\s*new Set\(\[)([\s\S]*?)(\]\);)/;
const ZSTD_MAGIC = 4247762216;

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const option = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

if (has("--help") || has("-h")) {
  printHelp();
  process.exit(0);
}

const dryRun = has("--dry-run");
const force = has("--force");
const mode = has("--revert") ? "revert" : has("--fix") ? "fix" : has("--check") ? "check" : "help";
const dshRoot = resolve(option("--dsh-root") || process.env.DSH_NPM_ROOT || defaultDshRoot() || ".");
const dshHome = resolve(process.env.DSH_HOME || join(os.homedir(), ".dsh"));
const sessionsRoot = join(dshHome, "sessions");

main().catch((error) => {
  console.error(`\n[失败] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

async function main() {
  if (mode === "help") {
    printHelp();
    return;
  }
  if (!existsSync(dshRoot)) {
    throw new Error(
      `找不到 dsh 安装目录：${dshRoot}\n` +
        '请用 --dsh-root 指定，例如：--dsh-root "%APPDATA%\\npm\\node_modules\\@deepseek-ai\\dsh"',
    );
  }

  console.log("dsh 安装目录:", dshRoot);
  console.log("dsh 版本    :", readVersion());
  console.log("会话目录    :", sessionsRoot);
  console.log("使用 node   :", process.version);
  console.log("");

  if (mode === "check") {
    process.exitCode = await checkAll();
    return;
  }
  if (mode === "fix") {
    process.exitCode = await fix();
    return;
  }
  process.exitCode = revert();
}

async function checkAll() {
  const targets = inspectTargets();
  const fileState = summarizeFiles(targets);
  printFileState(fileState);

  if (typeof zlib.zstdDecompressSync !== "function") {
    console.log("[异常] 当前 Node.js 版本过低，无法扫描 zstd 会话日志（需要 Node 22.15+）。");
    console.log("\n结论：请先升级 Node.js，再重新检查。");
    return 2;
  }

  const known = await loadKnownTypes();
  if (!known) {
    console.log("[异常] 无法读取当前 web 的事件词汇表，不能检查会话。");
    console.log("\n结论：安装结构异常。请不要点修复，把本窗口内容发给 Qoder。");
    return 2;
  }

  const scan = scanSessions(known);
  printScanState(scan);

  const fileBroken = fileState.kind === "broken";
  const fileUnpatched = fileState.kind === "unpatched";
  const unknownTypes = new Set();
  for (const item of scan.failed) for (const type of item.types) unknownTypes.add(type);
  const otherUnknown = [...unknownTypes].filter((type) => !REQUIRED_TYPES.includes(type));

  console.log("");
  if (!fileUnpatched && !fileBroken && scan.failed.length === 0 && scan.unreadable.length === 0) {
    console.log("结论：一切正常。");
    return 0;
  }
  if (fileBroken) {
    console.log("结论：补丁位置与当前 dsh 版本不匹配。请不要点修复，把本窗口内容发给 Qoder。");
    return 2;
  }
  if (otherUnknown.length > 0) {
    console.log(`结论：发现本工具不认识的其它事件类型：${otherUnknown.join(", ")}`);
    console.log("修复只能处理 job/registered、job/settled；请把本窗口内容发给 Qoder。");
    return 2;
  }
  if (fileUnpatched || scan.failed.length > 0) {
    console.log("结论：需要修复。请双击 1-修复.cmd。");
    return 2;
  }
  console.log("结论：补丁正常，但有会话日志无法读取。请关闭 dsh 后重试；仍失败就把本窗口内容发给 Qoder。");
  return 2;
}

function summarizeFiles(targets) {
  const missing = [];
  const unexpected = [];
  let patched = 0;
  for (const target of targets) {
    if (target.state === "missing") missing.push(target.rel);
    else if (target.state === "unexpected") unexpected.push(target.rel);
    else if (target.state === "patched") patched += 1;
  }
  if (missing.length === 0 && unexpected.length === 0) {
    return { kind: patched === TARGETS.length ? "patched" : "unpatched", patched, missing, unexpected };
  }
  return { kind: "broken", patched, missing, unexpected };
}

function printFileState(state) {
  if (state.kind === "patched") {
    console.log(`[正常] 补丁文件：${state.patched}/${TARGETS.length} 已就位`);
    return;
  }
  if (state.kind === "unpatched") {
    console.log(`[异常] 补丁文件：${state.patched}/${TARGETS.length} 已就位`);
    return;
  }
  console.log(`[异常] 补丁文件：安装结构不匹配（${state.patched}/${TARGETS.length} 已就位）`);
  for (const rel of state.missing) console.log(`  缺少：${rel}`);
  for (const rel of state.unexpected) console.log(`  找不到事件集合：${rel}`);
}

function scanSessions(known) {
  const result = { scanned: 0, failed: [], unreadable: [], rootMissing: false };
  if (!existsSync(sessionsRoot)) {
    result.rootMissing = true;
    return result;
  }

  const logs = listSessionLogs(sessionsRoot);
  for (const file of logs) {
    try {
      const analysis = analyzeSession(file, known);
      result.scanned += 1;
      if (analysis.unknown.length > 0) {
        result.failed.push({
          file,
          id: analysis.id,
          title: analysis.title,
          types: analysis.unknown.map((item) => item.type),
          samples: analysis.unknown,
        });
      }
    } catch (error) {
      result.unreadable.push({ file, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

function printScanState(scan) {
  if (scan.rootMissing) {
    console.log(`[提示] 没有找到会话目录：${sessionsRoot}`);
    return;
  }
  if (scan.failed.length === 0 && scan.unreadable.length === 0) {
    console.log(`[正常] 会话扫描：${scan.scanned} 个会话全部可被当前 web 读取`);
    return;
  }
  console.log(`[异常] 会话扫描：${scan.scanned} 个会话，${scan.failed.length} 个会被 web 拒绝，${scan.unreadable.length} 个无法读取`);
  for (const item of scan.failed) {
    const title = item.title ? ` “${item.title}”` : "";
    const types = item.samples.map((sample) => `${sample.type}（首次 seq ${sample.seq}）`).join("、");
    console.log(`  - ${shortId(item.id)}${title}`);
    console.log(`    未知事件：${types}`);
  }
  for (const item of scan.unreadable) {
    console.log(`  - 无法读取：${item.file}`);
    console.log(`    ${item.message}`);
  }
}

function listSessionLogs(dir) {
  const logs = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) logs.push(...listSessionLogs(path));
    else if (entry.name === "session.v4.jsonl.zstd" || entry.name === "session.v4.jsonl") logs.push(path);
  }
  return logs.sort();
}

function analyzeSession(file, known) {
  const buffer = readFileSync(file);
  const text = decodeLog(buffer);
  const rows = [];
  let parseErrors = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      parseErrors += 1;
    }
  }
  if (parseErrors > 0) throw new Error(`有 ${parseErrors} 行不是合法 JSON`);

  const header = rows.find(
    (row) => row && typeof row === "object" && row.seq === undefined && typeof row.version === "number" && row.id,
  );
  if (!header) throw new Error("找不到会话头");
  const events = rows.filter((row) => row !== header);
  const unknown = new Map();
  for (const event of events) {
    if (!event || typeof event !== "object" || typeof event.type !== "string") continue;
    if (known.has(event.type) || event.ignorable === true) continue;
    if (!unknown.has(event.type)) unknown.set(event.type, { type: event.type, seq: event.seq });
  }
  return { id: header.id, title: lastTitle(events), unknown: [...unknown.values()] };
}

function lastTitle(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "session/title" && typeof event.data?.title === "string") return event.data.title;
  }
  return "";
}

function shortId(id) {
  const match = /^session-([0-9a-f]{8})/i.exec(id);
  return match ? `session-${match[1]}…` : id;
}

function decodeLog(buffer) {
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC) {
    const { frames } = scanZstdFrames(buffer);
    let text = "";
    for (const { start, end } of frames) {
      text += zlib.zstdDecompressSync(buffer.subarray(start, end)).toString("utf8");
    }
    return text;
  }
  return buffer.toString("utf8");
}

function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`zstd 帧头无效（偏移 ${offset}）`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };

    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`zstd 帧头保留位异常（偏移 ${offset - 1}）`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`zstd 保留块类型（偏移 ${offset - 3}）`);
      const size = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < size) return { frames, tornStart: start };
      offset += size;
      if (lastBlock) break;
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

async function loadKnownTypes() {
  const reference = targetPath(TARGETS[0]);
  if (!existsSync(reference)) return null;

  for (const file of [reference, targetPath(TARGETS[1])]) {
    if (!existsSync(file)) continue;
    try {
      const module = await import(pathToFileURL(file).href + `?check=${Date.now()}-${Math.random()}`);
      if (module.KNOWN_SESSION_EVENT_TYPES instanceof Set) return module.KNOWN_SESSION_EVENT_TYPES;
    } catch {
      // 动态导入失败时继续用文本解析兜底。
    }
  }

  const content = readFileSync(reference, "utf8");
  const match = content.match(SET_RE);
  if (!match) return null;
  const types = [...match[2].matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1]);
  return types.length > 0 ? new Set(types) : null;
}

async function fix() {
  const targets = inspectTargets();
  const broken = targets.filter((target) => target.state === "missing" || target.state === "unexpected");
  if (broken.length > 0) {
    for (const target of broken) {
      console.log(`[无法修复] ${target.rel}（${target.state === "missing" ? "文件缺失" : "结构变化"}）`);
    }
    throw new Error("安装目录结构与工具预期不一致，请把本窗口内容发给 Qoder。");
  }

  const changes = [];
  for (const target of targets) {
    const result = patchContent(target.content);
    if (result.error) throw new Error(`${target.rel}：${result.error}`);
    if (result.changed) changes.push({ ...target, next: result.content });
  }

  if (changes.length === 0) {
    console.log("[正常] 补丁已经在，无需修复。");
    console.log("");
    return await checkAll();
  }

  if (dryRun) {
    for (const change of changes) console.log(`将修改：${change.rel}`);
    console.log("\n预演完成，未写入文件。");
    return 0;
  }

  const backupDir = createBackupDir();
  const manifest = {
    createdAt: new Date().toISOString(),
    note: "运行 dsh-fix.mjs 修复前的自动备份",
    dshVersion: readVersion(),
    machineId: machineId(),
    dshRoot,
    targets: targets.map((target) => {
      const file = targetPath(target.rel);
      const backupName = flatten(target.rel);
      const backupFile = join(backupDir, backupName);
      copyFileSync(file, backupFile);
      return { rel: target.rel, backup: backupName, sha256: sha256(readFileSync(backupFile)) };
    }),
  };
  writeFileSync(join(backupDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  try {
    for (const change of changes) writeFileSync(change.file, change.next, "utf8");
  } catch (error) {
    for (const target of manifest.targets) {
      copyFileSync(join(backupDir, target.backup), targetPath(target.rel));
    }
    throw error;
  }

  console.log(`[已备份] ${backupDir}`);
  console.log(`[已修复] ${changes.length} 个文件`);
  console.log("");
  const checked = await checkAll();
  if (checked === 0) {
    console.log("");
    console.log("请完全退出 dsh web，然后重新启动。");
  }
  return checked;
}

function revert() {
  const backups = listBackups();
  if (backups.length === 0) throw new Error("backups/ 里没有可用备份，无法回滚。");

  const latest = backups[0];
  const currentVersion = readVersion();
  const backupVersion = latest.manifest.dshVersion;
  const backupMachine = latest.manifest.machineId;
  if (backupMachine && backupMachine !== machineId() && !force) {
    throw new Error("这份备份来自另一台电脑，不能在本机回滚。请先在本机运行修复，自动生成属于本机的备份。");
  }
  if (!backupMachine) console.log("[提示] 该备份没有机器标识，可能来自旧版本；请确认它属于本机。");
  if (backupVersion && currentVersion && backupVersion !== currentVersion && !force) {
    throw new Error(
      `备份来自 dsh ${backupVersion}，当前是 ${currentVersion}。把旧文件写回新版本会损坏安装；如确认要回滚，加 --force。`,
    );
  }

  const plan = [];
  for (const target of latest.manifest.targets ?? []) {
    const backupFile = join(latest.dir, target.backup);
    const dest = targetPath(target.rel);
    if (!existsSync(backupFile)) throw new Error(`备份文件缺失：${backupFile}`);
    if (!existsSync(dest) && !force) throw new Error(`目标文件不存在：${dest}\n安装结构已变化，拒绝回滚。`);
    const bytes = readFileSync(backupFile);
    if (target.sha256 && sha256(bytes) !== target.sha256) throw new Error(`备份校验失败：${backupFile}`);
    plan.push({ rel: target.rel, backupFile, dest });
  }

  if (dryRun) {
    for (const item of plan) console.log(`将还原：${item.rel}`);
    console.log("\n预演完成，未写入文件。");
    return 0;
  }
  for (const item of plan) copyFileSync(item.backupFile, item.dest);
  console.log(`[已回滚] 还原 ${plan.length} 个文件（备份：${latest.dir}）`);
  console.log("请重新启动 dsh web。");
  return 0;
}

function inspectTargets() {
  return TARGETS.map((rel) => {
    const file = targetPath(rel);
    if (!existsSync(file)) return { rel, file, state: "missing" };
    const content = readFileSync(file, "utf8");
    const match = content.match(SET_RE);
    if (!match) return { rel, file, state: "unexpected", content };
    const present = REQUIRED_TYPES.filter((type) => hasType(match[2], type));
    return {
      rel,
      file,
      content,
      state: present.length === REQUIRED_TYPES.length ? "patched" : "unpatched",
    };
  });
}

function patchContent(content) {
  const match = content.match(SET_RE);
  if (!match) return { error: "找不到 KNOWN_SESSION_EVENT_TYPES 集合" };
  const block = match[2];
  const missing = REQUIRED_TYPES.filter((type) => !hasType(block, type));
  if (missing.length === 0) return { changed: false };

  const anchor = block.match(/([ \t]*)(["'])image\/offload\2\s*,/);
  if (!anchor) return { error: "事件集合中找不到 image/offload 锚点" };
  const indent = anchor[1];
  const quote = anchor[2];
  const insert = missing.map((type) => `\n${indent}${quote}${type}${quote},`).join("");
  const insertAt = anchor.index + anchor[0].length;
  const patchedBlock = block.slice(0, insertAt) + insert + block.slice(insertAt);
  return {
    changed: true,
    content: content.slice(0, match.index) + match[1] + patchedBlock + match[3] + content.slice(match.index + match[0].length),
  };
}

function hasType(block, type) {
  const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`['"]${escaped}['"]`).test(block);
}

function defaultDshRoot() {
  try {
    const npmRoot = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const candidate = join(npmRoot, "@deepseek-ai", "dsh");
    if (existsSync(candidate)) return candidate;
  } catch {
    // npm 不在 PATH 时退回 Windows 默认目录。
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(os.homedir(), "AppData", "Roaming");
    return join(appData, "npm", "node_modules", "@deepseek-ai", "dsh");
  }
  return "";
}

function machineId() {
  return sha256(Buffer.from(`${os.hostname()}|${os.platform()}`)).slice(0, 12);
}

function readVersion() {
  const file = join(dshRoot, "package.json");
  if (!existsSync(file)) return "未知";
  try {
    return JSON.parse(readFileSync(file, "utf8")).version ?? "未知";
  } catch {
    return "未知";
  }
}

function targetPath(rel) {
  return join(dshRoot, ...rel.split("/"));
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function flatten(rel) {
  return rel.split("/").join("__");
}

function createBackupDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  let dir = join(BACKUP_ROOT, `backup-${stamp}`);
  let suffix = 2;
  while (existsSync(dir)) dir = join(BACKUP_ROOT, `backup-${stamp}-${suffix++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function listBackups() {
  if (!existsSync(BACKUP_ROOT)) return [];
  return readdirSync(BACKUP_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(BACKUP_ROOT, entry.name, "manifest.json")))
    .map((entry) => {
      const dir = join(BACKUP_ROOT, entry.name);
      return { dir, manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) };
    })
    .sort((a, b) => String(b.manifest.createdAt ?? "").localeCompare(String(a.manifest.createdAt ?? "")));
}

function printHelp() {
  console.log(`一般直接双击同目录的 .cmd，不需要手动运行本文件。

手动用法：
  node dsh-fix.mjs --check     检查补丁 + 扫描全部会话
  node dsh-fix.mjs --fix       修复（自动备份）
  node dsh-fix.mjs --revert    回滚到最近一次备份

可选：
  --dsh-root <path>   指定 @deepseek-ai/dsh 安装根目录
  --force             回滚时忽略版本保护
  --help              显示本帮助`);
}
