'use strict';
/**
 * 插件契约的**打包侧副本**：类型、id 规则、声明文件（`plugin.json`）的形状与校验。
 *
 * 权威描述是本仓库的 `docs/plugin-contract.md`；这里只做"能不能打包 / 装得进去吗"的机械校验。
 *
 * ⚠️ 这份是面板 `server/modules/plugin/contract.js` 的子集（只留打包要用的那几件）。
 * 两个仓库分开之后没有共享代码的位置，**契约本身动了两边都要改**：
 *   · 面板那份决定"装的时候认不认"（权威，装包时拦在前面）；
 *   · 这份决定"打的时候让不让过"。
 * 口径不一致的后果是"包打得出来但装不上"，所以改字段规则时先改面板那份，再同步这里。
 *
 * 包（目录形式，打出来是一个 tar.gz）：
 *   plugin.json     声明（本文件校验的对象）
 *   index.js        main（默认 index.js）
 *   角色子目录       多类型包把各类型代码分在子目录里（见 docs/adr/0046）
 *   data/           插件自己的数据 —— **由面板在安装时创建，包里不该有**
 *   *.md            文档（源码目录里写给自己的笔记）—— **不随包发行**
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPES = ['metadata', 'source', 'home', 'output'];
const ID_RE = /^[a-z][a-z0-9._-]{1,63}$/i;

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

function fail(message) {
  const e = new Error(message);
  e.code = 'BAD_MANIFEST';
  return e;
}

/**
 * 不进包的东西：隐藏文件、插件自己的数据目录（`data/`，装包时才由面板创建）、
 * 以及文档（`*.md` —— 源码目录里的笔记不随包发行）。
 *
 * ⚠️ 打包脚本的 `copyTree` 与本文件的 `walk` **必须共用这一条口径**：
 * 一个决定"什么被复制进包"，一个决定"包内 `files` 清单里列什么"，两边不一致就会
 * 出现"包里有文件但清单没列"或"清单列了包里没有"，装包时第二道校验直接失败。
 */
function skipEntry(name) {
  return name.startsWith('.') || name === 'data' || /\.md$/i.test(name);
}

/** 目录下所有文件的相对路径（跳过 data/、隐藏文件与文档） */
function walk(dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipEntry(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/**
 * 校验一个解包后的插件目录。返回归一化后的声明；不合法就抛（`code = BAD_MANIFEST`）。
 *
 * 声明里给了 `files` 就逐个核对（那是"包的 md5"之外的第二道校验，正常装包时会核）。
 * 对不上就报出来 —— 不留半成品、也不"拿实际值覆写清单"假装成功。
 */
function readManifest(dir) {
  const file = path.join(dir, 'plugin.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw fail('读不到 plugin.json：' + ((e && e.message) || e));
  }
  if (!raw || typeof raw !== 'object') throw fail('plugin.json 必须是一个对象');

  const id = String(raw.id || '').trim();
  if (!ID_RE.test(id)) throw fail(`id 不合法：「${id || '(空)'}」（字母开头，字母数字与 . _ -，2~64 位）`);
  const name = String(raw.name || '').trim();
  if (!name) throw fail('缺少 name（显示名）');
  const version = String(raw.version || '').trim();
  if (!version) throw fail('缺少 version');

  /* types：新写法数组（多类型，见 docs/adr/0046）；旧写法单值 type 仍收。 */
  let types;
  if (Array.isArray(raw.types)) {
    types = raw.types.map((t) => String(t || '').trim());
  } else if (raw.type !== undefined && raw.type !== null) {
    types = [String(raw.type || '').trim()];
  } else {
    throw fail(`缺少 types（${TYPES.join(' / ')} 的数组；旧版单值 type 也仍接受）`);
  }
  if (!types.length || types.some((t) => !t)) throw fail('types 不能为空');
  for (const t of types) {
    if (!TYPES.includes(t)) throw fail(`types 里有不认识的类型：「${t}」（只认 ${TYPES.join(' / ')}）`);
  }
  if (new Set(types).size !== types.length) throw fail(`types 有重复：${types.join(' / ')}`);
  const type = types[0]; // 兼容仍读 m.type 的调用点；没有"主类型"语义

  const main = String(raw.main || 'index.js').trim();
  if (!fs.existsSync(path.join(dir, main))) throw fail(`入口文件不存在：${main}`);

  let domain = '';
  if (types.includes('metadata')) {
    domain = String(raw.domain || '').trim();
    if (!/^[a-z][a-z0-9]*$/i.test(domain)) {
      throw fail(`types 含 metadata 时必须声明 domain（域 id，就是条目 Id 的前缀）：「${domain || '(空)'}」不合法`);
    }
  }

  /* webui：单类型包给字符串或对象都行；多类型包必须给 {类型:入口} 的对象。
   * 统一归一化成 {类型:相对路径}（与面板 contract.js 同口径）。 */
  const webui = {};
  if (raw.webui !== undefined && raw.webui !== null && raw.webui !== '') {
    if (typeof raw.webui === 'string') {
      if (types.length > 1) throw fail('多类型插件的 webui 必须是 {类型:入口文件} 的对象，不接受单个字符串');
      const rel = raw.webui.trim();
      if (!fs.existsSync(path.join(dir, rel))) throw fail(`webui 入口不存在：${rel}`);
      webui[types[0]] = rel;
    } else if (raw.webui && typeof raw.webui === 'object' && !Array.isArray(raw.webui)) {
      for (const [role, rel0] of Object.entries(raw.webui)) {
        if (!types.includes(role)) throw fail(`webui 的 key「${role}」不在 types 里（${types.join(' / ')}）`);
        const rel = String(rel0 || '').trim();
        if (!rel) throw fail(`webui.${role} 入口为空`);
        if (!fs.existsSync(path.join(dir, rel))) throw fail(`webui.${role} 入口不存在：${rel}`);
        webui[role] = rel;
      }
    } else {
      throw fail('webui 必须是字符串（单类型包）或 {类型:入口文件} 对象');
    }
  }

  /* 自更新清单地址（可选；与面板 contract.js 同口径）：只收 http(s)，
   * 面板装包后会主动 GET 它，不能让 file:// 之类从清单里混进来。 */
  const updateUrl = String(raw.updateUrl || '').trim();
  if (updateUrl && !/^https?:\/\//i.test(updateUrl)) throw fail('updateUrl 必须是 http(s) 地址');

  const files = raw.files && typeof raw.files === 'object' ? raw.files : null;
  if (files) {
    for (const [rel, want] of Object.entries(files)) {
      const p = path.join(dir, rel);
      if (!fs.existsSync(p)) throw fail(`清单里声明的文件不存在：${rel}`);
      const got = md5(fs.readFileSync(p));
      if (got !== String(want).toLowerCase()) {
        throw fail(`文件校验不过：${rel}（清单 ${String(want).slice(0, 12)}… 实际 ${got.slice(0, 12)}…）`);
      }
    }
  }

  return {
    id,
    name,
    author: String(raw.author || '').trim(),
    version,
    types,
    type, // = types[0]，兼容旧调用点
    main,
    domain,
    series: raw.series !== false,
    /** 归一化后的 webui：`{类型:入口相对路径}`（没有就是 `{}`） */
    webui,
    updateUrl,
    depends: Array.isArray(raw.depends) ? raw.depends.map((x) => String(x)) : [],
    description: String(raw.description || '').trim(),
  };
}

module.exports = { TYPES, ID_RE, md5, fail, skipEntry, walk, readManifest };