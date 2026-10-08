# media-bridge-plugins

[媒体桥面板](https://github.com/dlushu/media-bridge-panel)的**插件仓库**：打好的包与清单都在这里。
插件源码（`plugins/`）是个人资产、不进本仓库；插件的**契约文档与开发工具**在
[MediaBridge-plugin-devkit](https://github.com/dlushu/MediaBridge-plugin-devkit)（开发套件仓）。

面板本身**不带插件**（见面板的 ADR-0035）。装完之后到面板的「插件 → 插件库」页从这里挑插件安装；
也可以在「插件 → 管理」页上传本地的 `.tar.gz` 手装。

## 这里有什么

```
plugins/<id>/                             插件源码（本地开发用；不进仓库；可多类型，角色放 roles/<类型>/）
docs/notes/                               过程记录（当时的计划与迁移留档）
docs/plugin-arch-draft.md                 插件化架构讨论存档（历史）
docs/plugin-migration-plan.md             施工批次计划（历史）
packages/<id>/<id>-<版本>.tar.gz            插件包（一个 id 一个目录，不按类型分目录）
packages/<id>/update.json                 自更新清单（Magisk 式，由打包工具生成）
index.json                                插件清单（面板「插件库」页拉的就是它）
```

`index.json` 的形状（`schema: 2`）：

```json
{
  "schema": 2,
  "generatedAt": "…",
  "plugins": [
    {
      "types": ["metadata", "home"],
      "id": "<插件 id>",
      "name": "<显示名>",
      "author": "<作者署名>",
      "version": "1.1.0",
      "description": "…",
      "domain": "<域 id>",
      "hasWebui": true,
      "depends": [],
      "bytes": "<包文件的字节数>",
      "md5": "<包文件的 md5>",
      "path": "packages/<插件 id>/<插件 id>-1.1.0.tar.gz"
    }
  ]
}
```

多类型包（`types` 多于一个）的 `plugin.json` 还要写**按类型映射的 webui 入口**，
入口动作按角色分组（详见开发套件仓 `framework/contracts/plugin-contract.md` 第二、四节与面板 ADR-0046）：

```json
{
  "id": "missav",
  "types": ["home", "metadata", "source"],
  "webui": { "home": "roles/home/ui/index.html", "metadata": "roles/metadata/ui/index.html", "source": "roles/source/ui/index.html" }
}
```

`md5` 是**包文件本身**的 md5（面板装包时的第一道校验）；包里的 `plugin.json` 还带一份
`files`（逐文件 md5，第二道校验），由打包脚本注入。两个数都随源码变化，不手工维护。

## 打一个插件

打包工具在开发套件仓：[MediaBridge-plugin-devkit](https://github.com/dlushu/MediaBridge-plugin-devkit)
的 `framework/tools/pack.js`。在本仓库根跑：

```bash
node <devkit>/framework/tools/pack.js --library catpaw            # 打一个（按插件 id）
node <devkit>/framework/tools/pack.js --library catpaw pikpak     # 打指定的几个
node <devkit>/framework/tools/pack.js --library --all             # 全量重建
```

- **一次只打指定的那些**：改了一个插件就只重打它，慢的是"每次全量重打"，其余包的 md5 也无谓地变。
- **`index.json` 按 `packages/` 里现有的包当场重算**（逐个解出包里的 `plugin.json` 取字段、再算包文件的
  md5 与字节数）—— 清单不会与包脱节，增量打包时其余条目也是现算的，不会读到旧数字。
- 打 `<id>` 之前会先删掉 `packages/<id>/` 整个目录 —— 升版本后不会新旧两个包并存于清单里。
- `--all` 会先清空 `packages/` 与 `index.json` 再全量重打（**唯一会丢东西的模式**，也是"要一份干净产物"时的入口）。
- 源码目录连契约都过不了会当场报错、不打包（面板装了也会拒），所以打包本身是一道前置校验。

改插件的闭环：

```bash
# 1) 改 plugins/<id>/ 下的源码
# 2) 重打那一个包
node <devkit>/framework/tools/pack.js --library <id>
# 3) 在面板里更新：把新包推上本仓库后在「插件 → 插件库」点更新，或直接在「插件 → 管理」上传这个 .tar.gz
```

## 面板怎么用它

面板默认从本仓库取清单与包，三个环境变量可以改：

| 变量 | 默认 |
|---|---|
| `PLUGIN_REPO` | `dlushu/media-bridge-plugins` |
| `PLUGIN_INDEX_URL` | 本仓库 `main` 分支根目录的 `index.json` |
| `PLUGIN_SOURCE_URL` | 本仓库 `main` 分支下的包地址（占位符 `{repo}` `{path}` `{type}` `{id}` `{version}`） |

自建镜像或放到内网时，把这三个变量指过去即可。

## 文档与决策在哪

- 插件能做什么、面板怎么调它：开发套件仓的
  [`framework/contracts/plugin-contract.md`](https://github.com/dlushu/MediaBridge-plugin-devkit/blob/main/framework/contracts/plugin-contract.md)（**契约的唯一来源**）。
- 源插件显示与定位规范、首页插件行与条目规范、webui 前端契约：同仓 `framework/contracts/`。
- 为什么这么设计（ADR）、面板自己的实现要点（`develop.md`、`ARCHITECTURE.md`）都在
  [面板仓库](https://github.com/dlushu/media-bridge-panel)—— 文档里指向它们的链接用绝对地址。
- 本仓库 `docs/` 下只剩历史存档（架构讨论、批次计划），不再是开发入口。
