# media-bridge-plugins

[媒体桥面板](https://github.com/dlushu/media-bridge-panel)的**插件包仓库**。

面板本身**不带插件**：装完之后到面板的「插件 → 插件库」页，从这里挑插件安装。
也可以在「插件 → 管理」页上传本地的 `.tar.gz` 手装。

## 这里有什么

```
index.json                              插件清单（面板的「插件库」页拉的就是它）
packages/<类型>/<id>/<id>-<版本>.tar.gz  插件包
```

`index.json` 的形状（`schema: 1`）：

```json
{
  "schema": 1,
  "generatedAt": "…",
  "plugins": [
    {
      "type": "metadata",
      "id": "tmdb",
      "name": "TMDB",
      "author": "media-bridge",
      "version": "1.0.0",
      "description": "元数据域 tmdb：按条目坐标取元数据与一季分集、按名字搜索；token 与缓存都归它自己",
      "domain": "tmdb",
      "hasWebui": true,
      "depends": [],
      "bytes": 25372,
      "md5": "b48e5784fe99267d9f82c7d9661a2292",
      "path": "packages/metadata/tmdb/tmdb-1.0.0.tar.gz"
    }
  ]
}
```

`md5` 是**包文件本身**的 md5（面板装包时的第一道校验）；包里的 `plugin.json` 还带一份
`files`（逐文件 md5，第二道校验），由打包脚本注入。

## 这些产物怎么来的

**不手工维护**。由打包脚本产出，输出目录就是本仓库的工作副本：

```bash
node tools/plugin-pack.js --out <本仓库的工作目录>
```

脚本把每个插件的源码打成 `tar.gz`、给包里的 `plugin.json` 注入 `files`（逐文件 md5），
再写出 `index.json`。插件源码由打包者自己保管，本仓库只收产物。

## 面板怎么用它

面板默认从本仓库取清单与包，三个环境变量可以改：

| 变量 | 默认 |
|---|---|
| `PLUGIN_REPO` | `dlushu/media-bridge-plugins` |
| `PLUGIN_INDEX_URL` | 本仓库 `main` 分支根目录的 `index.json` |
| `PLUGIN_SOURCE_URL` | 本仓库 `main` 分支下的包地址（占位符 `{repo}` `{path}` `{type}` `{id}` `{version}`） |

自建镜像或放到内网时，把这三个变量指过去即可。