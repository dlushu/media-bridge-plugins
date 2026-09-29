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
 *   ui/             可选：插件自己的 webui 静态文件
 *   data/           插件自己的数据 —— **由面板在安装时创建，包里不该有**
 *   *.md            文档（源码目录里写给自己的笔记）—— **不随包发行**
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPES = ['metadata', 'source', 'home'];
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
  const type = String(raw.type || '').trim();
  if (!TYPES.includes(type)) throw fail(`type 必须是 ${TYPES.join(' / ')}，实际是「${type || '(空)'}」`);
  const main = String(raw.main || 'index.js').trim();
  if (!fs.existsSync(path.join(dir, main))) throw fail(`入口文件不存在：${main}`);

  let domain = '';
  if (type === 'metadata') {
    domain = String(raw.domain || '').trim();
    if (!/^[a-z][a-z0-9]*$/i.test(domain)) {
      throw fail(`元数据插件必须声明 domain（域 id，就是条目 Id 的前缀）：「${domain || '(空)'}」不合法`);
    }
  }
  const webui = String(raw.webui || '').trim();
  if (webui && !fs.existsSync(path.join(dir, webui))) throw fail(`webui 入口不存在：${webui}`);

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
    type,
    main,
    domain,
    webui,
    depends: Array.isArray(raw.depends) ? raw.depends.map((x) => String(x)) : [],
    description: String(raw.description || '').trim(),
  };
}

module.exports = { TYPES, ID_RE, md5, fail, skipEntry, walk, readManifest };