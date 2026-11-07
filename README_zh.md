# LRCLib Lyrics for MyGo Music

[English](README.md)

一个为 MyGo Music 本地音乐带来时间同步歌词的插件。歌词来自
[LRCLib](https://lrclib.net/)：无需账号、无需 API Key；有同步 LRC 时返回
同步歌词，没有时回退为纯文本行，并按曲目 id 缓存结果。

## 歌词来源与致谢

所有歌词均来自 **[LRCLib](https://lrclib.net/)** —— 一个由社区维护、提供
公开 JSON API 的免费同步歌词数据库。

- **打开网站：** [https://lrclib.net/](https://lrclib.net/) → [LRCLib ↗](https://lrclib.net/)
- **插件使用的接口：**
  - `GET https://lrclib.net/api/get`
  - `GET https://lrclib.net/api/search`
- 不需要凭据，也不抓取网页 DOM。

**感谢 [LRCLib](https://lrclib.net/)**，以及所有上传、校对歌词的贡献者。
本插件只是其公开 API 的独立客户端，与 LRCLib 没有隶属关系，也未获得其
背书。请遵守该网站的[使用条款](https://lrclib.net/)并控制请求频率——插件的
后台同步默认只查少量歌曲，正是出于这个考虑。

## 为什么还要写 `.lrc` 文件

MyGo Music 是插件驱动的：`loadLyrics` 只会向**当前曲目所属 source** 要歌词；
内置的 **Local Files（本地文件）** source 只读取歌曲旁的 `.lrc` 或音频里的
时间轴歌词标签（`internal/local/local.go`），不会去问别的插件。因此本插件做
两件事：

1. 自己是一个 source：从插件侧栏播放时，`lyrics({id})` 直接生效。
2. 把找到的同步歌词写成歌曲旁的 `.lrc`：这样从 **Local Files** 播放时也
   能显示歌词，正好补上之前缺失的场景。

## 功能实现

| 行为 | 实现 |
| --- | --- |
| 主查询 | `GET https://lrclib.net/api/get`，参数 `artist_name`、`track_name`、`album_name`、`duration` |
| 请求标识 | `User-Agent: LRCLibLyrics/<version> (…)`、`Accept: application/json` |
| `syncedLyrics` | 作为 `lrc` 返回（由 App 自己解析 LRC） |
| `plainLyrics` | 作为带时间的 `lines` 返回，均匀分布在歌曲时长内（App 要求每行有时间） |
| 缓存 | `host.storage`，按曲目 id 保存，带有效期；短歌词 24 小时后再查一次 |
| 返回结构 | App 的 `music.Lyrics`：`{lrc, translation}` 或 `{lines}` |
| 来源标注 | 侧栏插件名称，以及每个设置项里的 LRCLib 链接 |

匹配与稳定性细节：

- `plainLyrics` 为 `null` 时做了保护，不会强转字符串导致报错。
- 短结果（≤ 5 行）最多每天复查一次，不会每次播放都重查。
- `/api/get` 返回 404（常见原因是本地索引里是合辑名）时，依次尝试：去掉
  `album_name` → 去掉 `duration` → 清洗后的标题 → `/api/search`。每个结果
  都会按歌名 / 歌手 / 专辑 / 时长打分，低分匹配直接丢弃，避免显示错词。
- 网络错误**不会**被缓存成「查无歌词」，下次播放会再试。
- 读取本地索引短暂失败时 5 秒后重试，不会把空目录缓存一分钟。
- 双语 LRC（同一时间戳有两行）会拆成 `lrc` + `translation`。
- 找到的同步歌词写成歌曲旁的 `.lrc`，绝不覆盖你已有的文件。

## 默认值（不留空框）

MyGo Music 的 `music.Setting` 只有 `key`、`label`、`help`、`link`，manifest
无法声明默认值。辅助程序的 `defaults` 模式会写入
`<app data>/plugin-data/lrclib-lyrics/settings.json`（只补缺失的 key，不覆盖
你的修改）；如果设置框为空，`index.js` 也会在内存中回退到同样默认值：

| 配置项 | 默认值 |
| --- | --- |
| `library` | `<app data>/local/index.json`（绝对路径） |
| `endpoint` | `https://lrclib.net` |
| `cacheHours` | `168` |
| `timeoutMs` | `8000` |
| `writeLrc` | `true` |
| `syncLimit` | `25` |
| `syncIntervalMinutes` | `15` |

没有 `artist`、`title`、`album` 覆盖项：元数据来自 App 的本地音乐库索引。
**本地安装**时 `npm run install:local` 会在 App 启动前写好文件，并用
`--force` 恢复全部默认值。**发布版安装**时 App 的安装器只复制文件，因此
`account()`（以及 `played()`）会在用户于「设置 > 插件」授权程序后调用一次
helper；失败的尝试一分钟后重试。App 在加载插件时才读取 `settings.json`，
所以下一次启动就能在设置框里看到这些值；功能不依赖这次重启，因为空框
本来就会使用上表的默认值。

## 从 Local Files 播放

App 的 Local Files source 会自己读取 `<歌曲同名>.lrc`。有两种写入方式：

```bash
npm run sync:lrc              # 每次 25 首，直接、可重复执行
npm run sync:lrc -- --all     # 整个音乐库，逐首处理
npm run sync:lrc -- --limit 100 --pause 250
```

`sync-lrc.mjs` 用模拟 host 加载插件自己的 `index.js`，所以查词、评分和
`storage.json` 缓存与 App 内完全一致；已有 `.lrc` 的歌曲会跳过。需要代理的
机器：

```bash
HTTPS_PROXY=http://127.0.0.1:10808 NODE_USE_ENV_PROXY=1 npm run sync:lrc
```

插件内的 `account()` 和 `played()` 也会启动有上限的后台同步（25 首、15
分钟间隔、8 秒预算），通过 helper 写 `.lrc`。由于 App 只会调用曲目所属
source 的 `played()`，要一次补齐**整个** Local Files 音乐库，上面的 CLI 更
可靠。

## 目录结构

```
plugin.json                  插件清单：权限、设置项、侧栏
index.js                     插件本体（单文件，无需构建）
locales/zh-CN.json           简体中文翻译
cmd/read-index/main.go       辅助程序：读索引、写默认值、写 .lrc
bin/read-index-<os>-<arch>   各平台辅助程序（保留可执行权限）
scripts/sync-lrc.mjs         为 Local Files 离线同步的 CLI
test/                        Node 单测（模拟 host / fetch）
scripts/app_test.go.txt      在 App 真实 JS 运行时里跑的 Go 测试
scripts/verify-in-app.sh     针对 mygo-music 源码运行该测试
scripts/build-helpers.sh     交叉编译 6 个平台的辅助程序
scripts/install-local.sh     本地安装插件 + 写入默认配置
scripts/pack.sh              打包 zip 供安装 / 发布
dist/                        zip 产物（已 gitignore）
```

插件没有文件系统 API，所以靠 `bin/read-index-*` 的 `process` 权限来读取
App 的 `local/index.json`、写 `settings.json` 和歌曲旁的 `.lrc`。辅助程序
只处理明确传给它的文件，并按 App 本地 source 的算法计算
`sha256("track\x00"+path)[:16]` 曲目 id。

## 开发环境

要求：Node ≥ 20；Go ≥ 1.27（仅辅助程序和 App 运行时测试需要）。无需
`npm install`，测试使用 Node 自带的 test runner。

```bash
npm run check          # 检查 index.js 与 sync-lrc.mjs 语法
npm test               # 28 个离线单测（模拟 host / LRCLib）
npm run go:test        # 辅助程序 Go 单测（默认值、.lrc、文件名）
npm run build:helpers  # 交叉编译 bin/read-index-*（6 平台）
npm run pack           # 生成 dist/*.zip，保留可执行位
npm run release        # 发布 v<version>，带全部 zip 资产
npm run install:local  # 复制到 App 插件目录 + 写入默认配置
npm run verify:app     # 在 MyGo Music 真实 JS 运行时里加载插件
```

`verify:app` 需要 `egoist/mygo-music` 的源码：设置 `MYGO_MUSIC_SRC`，或让
脚本克隆到 `.dev/mygo-music`。它会把 `scripts/app_test.go.txt` 复制进
`internal/plugin/` 并执行 `go test`。Go 测试使用本地 mock LRCLib 服务、
单曲索引和真实辅助程序，完全离线，同时校验播放器实际消费的
`music.Lyrics` 结构。若 Go 模块下载无法验证证书，会使用 `.dev/goproxy`
这个小型 `file://` 代理缓存；普通网络不需要。

## 在 App 中安装

1. `npm run build:helpers`（一次即可，产物在 `bin/`）。
2. `npm run install:local`，或在 **设置 > 插件 > +** 选择本目录 /
   `dist/lrclib-lyrics.zip`。
3. 启动 App。在 **设置 > 插件**里允许 *LRCLib Lyrics* 启动辅助程序
   （`bin/read-index-*`）。App 会提示授权，因为程序能做用户能做的事；
   这里的 helper 只读取 `index.json`、写默认值、在歌曲旁写新的 `.lrc`。
4. 可以从 **LRCLib Lyrics** 侧栏 source 播放，或运行一次
   `npm run sync:lrc` 后继续从 **Local Files** 播放。

## 发布

安装按钮：
[![在 MyGo Music 中安装](https://img.shields.io/badge/MyGo%20Music-Install-blue)](mygo-music://install-plugin?repo=AdkinsHan/mygo-local-lyrics)

按 [Publishing a plugin](https://github.com/egoist/mygo-music#publishing-a-plugin)
的说明：把 `plugin.json` 放在公开 GitHub 仓库根目录。App 会取最新 Release
里按平台命名的 `.zip`（如 `plugin-darwin-arm64.zip`）、不带平台名的 zip，
或源码；没有 Release 则取默认分支最新 commit。新 tag / commit 会显示为
更新。每个平台 zip 只带该平台的 helper，通用 zip 带全部 6 个。

```bash
npm run build:helpers   # bin/ 已 gitignore，全新 clone 里没有辅助程序
npm run pack            # 缺少 6 个 helper 中任何一个都会直接报错
npm run release         # 发布 v1.1.1，带全部 7 个 zip
```

`npm run release` 是 `gh release create` 的薄封装，会检查 tag 与
`plugin.json` 一致且是**小写** `v` 开头：App 只认识小写 `v` 开头的数字
tag，无法解析的 tag 会让之后的任何 tag 都显示为「有新版本」。

仓库是公开的，且已加 `mygo-music-plugin` topic，因此会出现在
[插件列表页](https://mygo-music.egoist.dev/plugins)。安装链接为
`mygo-music://install-plugin?repo=AdkinsHan/mygo-local-lyrics`。

插件要求 App **0.1.8+**：`host.t()` 和 `locales/` 翻译是 0.1.8 才加入的
（0.1.7 只是开始允许 `process` 权限指定程序）。0.1.8 之前的 App 会忽略
`minAppVersion`，所以当 `host.t` 不存在时 `index.js` 会回退到英文，而不是
直接报错。仅靠源码 zipball 无法安装（`bin/` 已 gitignore），必须发布带
zip 资产的 Release，这也是上面一次性上传 7 个 zip 的原因。

`network` 只允许 `lrclib.net`。若自定义 endpoint 指向其他域名，需要把该
域名加入网络权限。

## 限制

- App 不会为属于其他 source 的曲目去问插件要歌词，这就是写 `.lrc` 的原因。
- 后台同步刻意很小（25 首 / 15 分钟），因为 LRCLib 由社区运营；首次全库
  补齐请用 `sync:lrc --all`。
- 只有当 LRCLib 的 LRC 本身带成对行时，才会出现翻译。
- LRCLib 是社区数据库：覆盖率取决于用户上传，带专辑名 / 时长的精确匹配
  也可能查不到。

## 许可

AGPL-3.0，与 MyGo Music 一致，见 [LICENSE](LICENSE)。歌词由
[LRCLib](https://lrclib.net/) 提供，按其自身条款使用。
