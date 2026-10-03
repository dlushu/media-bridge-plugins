#!/usr/bin/env node
'use strict';
/**
 * 打包插件：把本仓库 `plugins/<id>/` 打成插件包，并重算 `index.json`。
 *
 * **源码与产物都按 id 平铺，不按类型分目录** —— 包身份只看 `plugin.json` 的 id，
 * 类型（可多个）写在声明里，不体现在路径上。
 *
 * 用法（`--out` 省略时就是**当前目录**，在仓库根直接跑即可）：
 *
 *   node tools/plugin-pack.js fwrex                 打一个（按插件 id）
 *   node tools/plugin-pack.js catpaw pikpak         打指定的几个
 *   node tools/plugin-pack.js --all                 全量重建
 *
 * 产物（写进 `--out`，**`.git` 一概不碰**）：
 *   index.json                          清单（面板「插件库」拉的就是它）
 *   packages/<id>/<id>-<版本>.tar.gz      包本体
 *   packages/<id>/update.json            自更新清单（**仅插件声明了 updateUrl 时**生成）
 *
 * **一次只打一个（或指定的几个）**：全量重建会把每个插件都重打一遍，
 * 改了一个插件时既慢，也让其余包的 md5 无谓地变。`--all` 留给"要一份干净的产物"时用。
 *
 * ⚠️ **清单不是记在别处的账，而是按 `--out` 里现有的包当场算出来的**：
 * 每次打包都扫一遍 `packages/**`，逐个解出包里的 `plugin.json` 取字段、再算包文件的 md5
 * 与字节数。所以增量打一个插件时，其余条目也是从包上现算的 —— 不会出现
 * "改了源码但清单还是旧数字"这种漂移，也不会因为漏更新某一条而对不上。
 *
 * ⚠️ **按 id 清旧包**：打 `<id>` 之前先删掉 `packages/<id>/` 整个目录，
 * 免得升版本后新旧两个包同时躺在里面、清单里出现两条同 id 的条目。
 *
 * 为什么要"注入 files"：包内 `plugin.json` 的 `files` 是**第二道校验**（逐文件 md5），
 * 面板安装时按它对包里的每个文件核一遍（见 docs/plugin-contract.md 第二节）。
 * 源码里不写这个字段 —— 写死 md5 会让每次改代码都要手改一处；改由这里在打包时算出来，
 * 只写进**包里那一份** `plugin.json`。
 *
 * 清单结构与仓库约定见 docs/plugin-contract.md 第七节。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const contract = require('./contract');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'plugins');

/** 清单结构版本（与面板 server/modules/plugin/library.js 的 SCHEMA 是同一个数）。
 * v2：条目用 types 数组（多类型包，见 docs/adr/0046）。 */
const SCHEMA = 2;

const md5 = contract.md5;

/* -------------------------------------------------------------- 参数与目录 */

/** 取 `--flag value` 的值（没有就回空串） */
function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '').trim() : '';
}

/** 位置参数（非 `--` 开头、且不是某个 `--flag` 的值）：要打的那几个插件 */
function positionals() {
  const args = process.argv.slice(2);
  const out = [];
  const withValue = new Set(['--out']);
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (withValue.has(args[i])) i++; // 跳过它的值
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

/**
 * 仓库里所有插件源码目录（有 plugin.json 才算）：**平铺** `plugins/<id>/`。
 * 类型只由 plugin.json 的 `types` 说了算，路径里不带类型。
 */
function listSources() {
  const out = [];
  if (!fs.existsSync(SRC)) return out;
  for (const one of fs.readdirSync(SRC, { withFileTypes: true })) {
    if (!one.isDirectory() || one.name.startsWith('.')) continue;
    const dir = path.join(SRC, one.name);
    if (!fs.existsSync(path.join(dir, 'plugin.json'))) continue;
    out.push({ spec: one.name, dirName: one.name, dir });
  }
  return out;
}

/** `<id>` → 源码目录（找不到就抛，并列出可用的）。带 `前缀/` 也认，取最后一段当 id。 */
function sourceOf(spec) {
  const all = listSources();
  const want = String(spec).split('/').map((x) => x.trim()).filter(Boolean).pop() || '';
  const hit = all.find((x) => x.spec === want) || null;
  if (!hit) {
    throw new Error(
      `没有这个插件：「${spec}」${all.length ? `\n  仓库里现有的：${all.map((x) => x.spec).join('  ')}` : ''}`
    );
  }
  return hit;
}

/**
 * 复制一份包内容：**跳过 `data/`、隐藏文件与文档（`*.md`）**
 * —— 口径由 `contract.skipEntry` 一处定义，与算 `files` 的 `contract.walk` 共用。
 */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    if (contract.skipEntry(ent.name)) continue;
    const a = path.join(from, ent.name);
    const b = path.join(to, ent.name);
    if (ent.isDirectory()) copyTree(a, b);
    else fs.copyFileSync(a, b);
  }
}

/* ------------------------------------------------------------------ 打一个包 */

/**
 * 打一个插件包。返回清单条目（多两个 `_` 前缀的显示用字段）。
 *
 * ⚠️ 先用 `contract.readManifest` **校验源码目录**：包要是连契约都过不了，
 * 就不该被打出来（更不该进清单 —— 面板装了也会当场拒绝）。
 */
function packOne(one, outRoot, tmpRoot) {
  const m = contract.readManifest(one.dir); // 校验（id / name / version / types / main / webui / domain…）

  const stage = path.join(tmpRoot, `stage-${m.id}`);
  fs.rmSync(stage, { recursive: true, force: true });
  copyTree(one.dir, stage);

  /* 第二道校验：算包里每个文件的 md5，写进包内那一份 plugin.json。
   * `plugin.json` 自己不算（无法自校验），这也正是契约里 `files` 的口径。 */
  const files = {};
  for (const rel of contract.walk(stage)) {
    if (rel === 'plugin.json') continue;
    files[rel] = md5(fs.readFileSync(path.join(stage, rel)));
  }
  const declared = JSON.parse(fs.readFileSync(path.join(stage, 'plugin.json'), 'utf8'));
  declared.files = files;
  fs.writeFileSync(path.join(stage, 'plugin.json'), JSON.stringify(declared, null, 2) + '\n');

  /* 产物一律放 `packages/<id>/`（不按类型分目录；多类型包本来也这样）：
   * 一个 id 一个目录，放着包本体与 update.json。升版本后不留着上一版，
   * 否则清单里会出现两条同 id 的条目。 */
  const pkgRelDir = path.join('packages', m.id);
  const pkgDir = path.join(outRoot, pkgRelDir);
  fs.rmSync(pkgDir, { recursive: true, force: true });
  fs.mkdirSync(pkgDir, { recursive: true });

  const pkgName = `${m.id}-${m.version}.tar.gz`;
  const rel = `${pkgRelDir.split(path.sep).join('/')}/${pkgName}`;
  const target = path.join(outRoot, rel);
  /* `-C <stage> .` ⇒ 包内顶层就是包内容（不套一层插件目录名） */
  execFileSync('tar', ['-czf', target, '-C', stage, '.'], { stdio: 'pipe' });

  const buf = fs.readFileSync(target);
  fs.rmSync(stage, { recursive: true, force: true });

  /* 自更新清单（Magisk 式）：插件在 plugin.json 声明 updateUrl 指向这里。
   * `url` 只写**同目录文件名**（相对引用），面板按 updateUrl 所在目录解析 ——
   * 这样包托管在 GitHub raw 还是别的镜像都不用改打包配置。
   * 不进 index.json：插件库那条路不依赖它（两条来路互相独立）。 */
  if (m.updateUrl) {
    const updateInfo = { version: m.version, url: pkgName, md5: md5(buf) };
    const changelog = String(declared.changelog || '').trim();
    if (changelog) updateInfo.changelog = changelog;
    fs.writeFileSync(path.join(pkgDir, 'update.json'), JSON.stringify(updateInfo, null, 2) + '\n');
  }

  return {
    types: m.types,
    type: m.type, // = types[0]，兼容仍读单值的地方
    id: m.id,
    name: m.name,
    author: m.author,
    version: m.version,
    description: m.description,
    domain: m.domain,
    hasWebui: Object.keys(m.webui || {}).length > 0,
    depends: m.depends,
    bytes: buf.length,
    md5: md5(buf),
    path: rel,
    /* 顺带给打包时看的两个数（不进清单 —— 清单的字段由契约规定，不塞私有字段） */
    _files: Object.keys(files).length + 1,
    _dirName: one.dirName,
  };
}

/* ---------------------------------------------------------------- 清单重算 */

/** `packages/` 下所有包（相对 outRoot 的路径），排序稳定 */
function collectPackages(outRoot) {
  const root = path.join(outRoot, 'packages');
  const out = [];
  const walkDir = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walkDir(full);
      else if (ent.name.endsWith('.tar.gz')) out.push(full);
    }
  };
  if (fs.existsSync(root)) walkDir(root);
  return out.sort();
}

/** 从一个包里读出清单条目：解出 `plugin.json`（顺带把第二道校验核一遍）+ 算包文件的 md5 */
function entryOfPackage(file, outRoot, tmpRoot) {
  const stage = path.join(tmpRoot, 'unpack');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  execFileSync('tar', ['-xzf', file, '-C', stage], { stdio: 'pipe' });
  const m = contract.readManifest(stage); // 包里那份带 files ⇒ 这里会逐文件核对
  const buf = fs.readFileSync(file);
  fs.rmSync(stage, { recursive: true, force: true });
  return {
    types: m.types,
    type: m.type, // = types[0]
    id: m.id,
    name: m.name,
    author: m.author,
    version: m.version,
    description: m.description,
    domain: m.domain,
    hasWebui: Object.keys(m.webui || {}).length > 0,
    depends: m.depends,
    bytes: buf.length,
    md5: md5(buf),
    path: path.relative(outRoot, file).split(path.sep).join('/'),
  };
}

/** 重算并写回 index.json：**以 `packages/` 里现有的包为准** */
function rebuildIndex(outRoot, tmpRoot) {
  const seen = new Map();
  const plugins = collectPackages(outRoot).map((f) => entryOfPackage(f, outRoot, tmpRoot));
  /* 同 id 多包在 v2 是不允许的（一个 id 只能有一条）：增量删旧没删干净时当场点名 */
  for (const e of plugins) {
    if (seen.has(e.id)) throw new Error(`packages/ 里存在两个 id=${e.id} 的包（${seen.get(e.id)} 与 ${e.path}），先删掉旧的`);
    seen.set(e.id, e.path);
  }
  plugins.sort((a, b) => (a.types[0] === b.types[0] ? a.id.localeCompare(b.id) : a.types[0].localeCompare(b.types[0])));
  /* 清单条目只发契约字段（types 数组，不发兼容用的单值 type） */
  const clean = plugins.map(({ types, id, name, author, version, description, domain, hasWebui, depends, bytes, md5, path: p }) => {
    const row = { types, id, name, author, version, description, domain: domain || undefined, hasWebui, depends, bytes, md5, path: p };
    for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
    return row;
  });
  const index = { schema: SCHEMA, generatedAt: new Date().toISOString(), plugins: clean };
  fs.writeFileSync(path.join(outRoot, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  return plugins;
}

/* ---------------------------------------------------------------------- 主 */

function main() {
  const outRoot = path.resolve(argValue('--out') || process.cwd());
  const all = process.argv.includes('--all');
  const specs = positionals();

  if (!all && !specs.length) {
    console.error(
      '用法：node tools/plugin-pack.js <id> [更多…] [--out <目录>]\n' +
        '      node tools/plugin-pack.js --all [--out <目录>]\n' +
        '（--out 省略 = 当前目录）'
    );
    process.exit(2);
  }
  fs.mkdirSync(outRoot, { recursive: true });

  let sources;
  try {
    /* `--all` 先清空产物：这是**唯一**会丢东西的模式，也是"要一份干净产物"时的入口。
     * 增量模式（给了具体插件）不碰别的插件的包。 */
    if (all) {
      fs.rmSync(path.join(outRoot, 'packages'), { recursive: true, force: true });
      fs.rmSync(path.join(outRoot, 'index.json'), { force: true });
      sources = listSources();
      if (!sources.length) throw new Error(`没有找到任何插件：${path.relative(ROOT, SRC)}/<id>/plugin.json`);
    } else {
      sources = specs.map(sourceOf);
    }
  } catch (e) {
    console.error('✘ ' + ((e && e.message) || e));
    process.exit(1);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-pack-'));
  const entries = [];
  try {
    for (const one of sources) entries.push(packOne(one, outRoot, tmpRoot));
    const index = rebuildIndex(outRoot, tmpRoot).length;
    entries.sort((a, b) => (a.type === b.type ? a.id.localeCompare(b.id) : a.type.localeCompare(b.type)));

    console.log(`\n插件仓库产物 → ${outRoot}\n`);
    for (const e of entries) {
      if (e._dirName !== e.id) console.log(`  ⚠ 目录名与 plugin.json 的 id 不一致：…/${e._dirName} → ${e.id}`);
      console.log(
        `  ${e.types.join('/').padEnd(20)} ${e.id.padEnd(10)} v${String(e.version).padEnd(8)} ${String(e._files).padStart(3)} 文件  ` +
          `${String(e.bytes).padStart(8)}B  md5 ${e.md5.slice(0, 8)}…`
      );
    }
    console.log(`\n  本次打 ${entries.length} 个；index.json 已按 packages/ 重算，共 ${index} 个插件。`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main();