---
doc_type: architecture
status: active
updated: 2026-11-24
tags: [封面, 外网接口]
---

# 游戏封面

REQ-024 的设计。需求见[产品需求](../requirements/product.md)，拆包见[工作包登记](../development/work-packages.md)。

## 目录

- [1. 范围](#1-范围)
- [2. 模块划分](#2-模块划分)
- [3. 来源接口](#3-来源接口)
  - [VNDB](#vndb)
  - [Bangumi](#bangumi)
  - [Steam](#steam)
  - [NextMoe](#nextmoe)
- [4. 图片主机](#4-图片主机)
- [5. 公共请求规则](#5-公共请求规则)
- [6. 封面存储](#6-封面存储)
- [7. 对端封面](#7-对端封面)
- [8. 界面](#8-界面)

## 1. 范围

- 三个入口：本机选图、按关键词从 VNDB、NextMoe、Bangumi、Steam 搜索、从对端导入游戏时取对端的封面。
- 只在用户打开搜索并提交关键词时访问外网，不做批量刮削、启动时补全或后台更新。
- 都不登录，不保存任何来源的账号或令牌。
- 不提供手动裁剪；卡片按 3:4 等比缩放并居中裁剪显示。
- 可以移除封面，恢复渐变占位封面。
- 对端的封面只在导入游戏时取一次；之后任一端换封面，另一端不跟着变。
- 某个来源连不上时，只显示这个来源的网络错误，不重试、不换用其他来源或其他接口。

## 2. 模块划分

请求的构造、响应解析、关键词清理、限流和错误分类都写在共享包，两端原生层只提供一个受限的 HTTP 执行器。搜索流程在两端的 WebView 里跑同一份代码。

| 位置 | 职责 |
| --- | --- |
| `apps/shared/src/poster/` | 已实现。`PosterSearchClient` 按来源生成请求、交给注入的执行器、解析成统一候选，按 `POSTER_REQUEST_INTERVALS_MS` 给各来源排队，失败抛带来源和错误码的 `PosterSearchError`；另有主机白名单、执行器响应守卫、`createPosterUserAgent` 和默认关键词。`PosterApi` 是两端原生层的五个方法（第 6 节），`createPosterAdapter` 把它包成带 `PosterSearchClient` 的 `PosterAdapter`，一个应用进程只建一个。纯 TypeScript，不做 IO，计时由注入的 `PosterClock` 提供 |
| `apps/shared/src/ui/poster/` | 已实现。`PosterCover`（游戏卡片、候选和缩略图共用的 3:4 封面，图片加载失败时退回占位）、`PosterRow`（设置页的封面一行）、`PosterCandidateGrid`、`PosterSearchState`（加载、无结果、失败和重试）、`poster-labels.ts`（来源显示名、封面类别文案）、`encodePosterWebp`（WebView canvas 缩放编码）；Hook `usePosterSearch`（来源、关键词、NextMoe 作品两步和预览图下载）、`usePosterUrls`（游戏封面读出成 `blob:` URL）。这些只依赖 `PosterAdapter`，两端共用；弹层和选图后的保存流程留在各端 |
| 电脑界面 `features/games/PosterSearchModal.tsx`，`platform/poster-adapter.ts` | 已实现。antd Modal 搜索弹层；适配器接 `window.desktopPoster` |
| 电脑 sidecar `backend/poster-*.ts` | 已实现。用 `node:https` 执行请求和下载图片；封面文件读写；通道 `desktopPoster` |
| 移动界面 `features/games/PosterSearchSheet.tsx`，`platform/poster-bridge.ts`、`posters.ts` | 已实现。底部弹层搜索；桥接校验原生插件 `Poster` 的参数和结果 |
| Android `PosterPlugin.java`、`PosterHttp.java`、`PosterStore.java`、`PosterRules.java` | 已实现。用 `HttpURLConnection` 执行请求和下载图片；系统照片选择器；封面文件读写 |

执行器只接受 `https`，API 请求的主机限定为第 3 节的五个接口主机，图片下载的主机限定为第 4 节的图片主机。两端都不能由 WebView 直接请求外网：Android WebView 跨域会被拦，电脑端 CSP 的 `img-src` 只允许 `'self' data: blob:`，`connect-src` 不含外网。候选的预览图也经执行器下载，转成 `blob:` URL 显示。

不采用 Android 另用 Java 写一份完整请求和解析的方案：两份解析要分别维护和测试，接口变化时容易漏改一端。

## 3. 来源接口

本节是 2026-11-23 不登录实测的结果。

用 13 个真实游戏名（中文译名、日文原名、英文名各有）经 `PosterSearchClient` 以默认关键词搜索四个来源，52 次请求都成功，没有触发限流：

| 来源 | 有结果 | 第一条就是目标游戏 |
| --- | --- | --- |
| VNDB | 13 | 13 |
| NextMoe | 13 | 13 |
| Bangumi | 10 | 5；其余是名字相近的其他条目，或查不到目标 |
| Steam | 7 | 4；多数游戏没有上架 Steam |

VNDB 和 NextMoe 用译名、原名都能搜到；Bangumi 和 Steam 只适合补充。界面默认来源用 VNDB。

候选的统一字段：`source`、`id`、`title`、`subtitle`、`detail`（发售日期、开发商、尺寸等，用 ` · ` 连接）、`previewUrl`、`downloadUrl`。NextMoe 的作品候选另带 `workId`，用于第二步列出封面。

### VNDB

- 请求：`POST https://api.vndb.org/kana/vn`，`Content-Type: application/json`。
- 请求体：`filters` 为 `["search", "=", <关键词>]`，`sort` 为 `searchrank`，`results` 取 1～10（超过 100 返回 400 `Invalid 'results' member.`）。`searchrank` 只能配顶层的 `search` 过滤器，否则返回 400。
- `fields`：`title,alttitle,titles.lang,titles.title,released,image.url,image.thumbnail,developers.name,developers.original`。
- 响应 `results[]`，例：`id` 为 `v19073`，`title` 为罗马字 `Senren * Banka`，`alttitle` 为原名 `千恋＊万花`，`titles[]` 每项带 `lang`、`title`、`main`、`official`，其中有 `zh-Hans`、`zh-Hant` 的中文名。
- 标题：`titles[]` 里第一个 `lang` 为 `zh-Hans` 或 `zh-Hant` 的 `title`，没有时用 `alttitle`，再没有时用 `title`。副标题用 `title`（与标题相同时省略）。开发商取 `developers[]` 前三个的 `original`，没有时取 `name`，用 ` / ` 连接。
- 图片：`image.url` 是原图（例 402×560），`image.thumbnail` 是缩略图（例 256×357），都在 `t.vndb.org`。预览用缩略图，下载用原图。`image.dims` 给原图尺寸。
- 限流：两次请求至少间隔 1.55 秒（5 分钟不超过 200 次）。

### Bangumi

- 请求：`POST https://api.bgm.tv/v0/search/subjects?limit=<1～10>&offset=0`，`Content-Type: application/json`（带 `; charset=utf-8` 同样返回 200）。
- 请求体：`{"keyword": <关键词>, "sort": "match", "filter": {"type": [4]}}`（`type` 4 是游戏），其余过滤参数见代码。
- 必须带 `User-Agent`，不带时返回 403，`description` 为 `Please set a 'User-Agent'`。
- 响应 `data[]` 每项有 `id`、`type`、`name`、`name_cn`、`date`、`platform`、`images` 等；`total` 是总条数。只保留 `type` 为 4 的条目。
- 标题：`name_cn`，为空时用 `name`；副标题 `name`（与标题相同时省略）；`detail` 带 `date`。
- 图片：`images` 有 `large`（原图，例 600×900）、`medium`（`/r/800/`，例 600×900，体积小两成）、`common`（`/r/400/`，例 400×600）、`small`、`grid`，都在 `lain.bgm.tv`。预览用 `common`，下载用 `large`；`large` 为空的条目丢弃。

### Steam

两次请求：先搜索，再按 appid 批量取竖版封面的地址。

- 搜索：`GET https://store.steampowered.com/api/storesearch/?term=<关键词>&l=schinese&cc=CN`。响应 `items[]` 每项有 `id`、`name`、`type`（都是 `app`）、`tiny_image`（横版小图）。取前 1～10 条。
- 关键词要贴近商店名：“千恋万花”只搜到体验版，“千恋＊万花”和“Senren Banka”能搜到正式版；日文“サマーポケッツ”搜不到。
- 取封面地址：`GET https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=<JSON>`，不需要密钥。`input_json` 为 `{"ids":[{"appid":<id>},…],"context":{"language":"schinese","country_code":"CN"},"data_request":{"include_assets":true}}`，一次可带多个 appid。
- 响应 `response.store_items[]` 的 `assets` 里，`asset_url_format` 形如 `steam/apps/<id>/${FILENAME}?t=<时间戳>`，`library_capsule` 是竖版封面的文件名，`library_capsule_2x` 是两倍尺寸。把文件名代入 `${FILENAME}`，前面加 `https://shared.akamai.steamstatic.com/store_item_assets/` 得到图片地址。
- 新上架的游戏文件名带一段 hash（例 `ebc9…da9d/library_600x900.jpg`），有中文版封面时文件名带语言（例 `library_600x900_schinese.jpg`）。固定路径 `steam/apps/<id>/library_600x900.jpg` 对新游戏返回 404，不能直接拼。
- 预览用 `library_capsule`（600×900），下载用 `library_capsule_2x`（1200×1800），没有 2x 时用 1x。没有 `library_capsule` 的条目（例 DLC）丢弃。

### NextMoe

两步：先选作品，再选这部作品的某张封面。

- 搜索作品：`GET https://api.nextmoe.dev/v2/catalog/works?q=<关键词>&limit=<1～10>`，其余参数见代码。`limit` 超过 100 返回 400，`code` 为 `LIMIT_TOO_LARGE`。
- 作品 `items[]` 每项有 `id`、`display_name`、`latin`、`localized`、`release_date`、`cover`（`url`、`width`、`height`）。实测样本的 `localized` 都是空对象、`cover.width` 和 `height` 都是 null，所以标题只用 `display_name`，副标题用 `latin`（为 null 时省略）。预览用 `cover.url`。
- 列出封面：`GET https://api.nextmoe.dev/v2/catalog/works/<作品 id>/covers?limit=<1～100>`，作品 id 按路径段编码。
- 封面 `items[]` 每项有 `id`、`cover_kind`（`main`、`pkgfront`、`pkgback`、`dig` 等）、`url`、`width`、`height`、`portrait_pinned`、`vote_count`、`source`。按 `portrait_pinned` 为真的在前，其余保持接口顺序；`subtitle` 用 `cover_kind`，`detail` 带尺寸。同一张图预览和下载。
- 作品不存在时列封面返回 404，`Content-Type: application/problem+json`，`code` 为 `NOT_FOUND`。
- 错误响应都是 `application/problem+json`，带 `status`、`code`、`detail`；HTTP 429 或 `code` 为 `RATE_LIMITED`、`QUOTA_EXCEEDED` 时按限流处理。
- 限流：响应头 `ratelimit-policy: 50;w=60, 10000;w=86400`，即不登录每分钟 50 次、每天 10000 次。两次请求至少间隔 1.3 秒。

## 4. 图片主机

| 来源 | 主机 | 格式 |
| --- | --- | --- |
| VNDB | `t.vndb.org` | JPEG |
| Bangumi | `lain.bgm.tv` | JPEG |
| Steam | `shared.akamai.steamstatic.com` | JPEG |
| NextMoe | `image.kungal.iloveren.link` | WebP |

四个主机不带 `Referer`、带非来源网站的 `Referer`、不带 Cookie 时都返回 200，下载不加 `Referer` 和 Cookie。NextMoe 的图片主机由它的接口返回，换主机后要同步白名单。

## 5. 公共请求规则

- 请求头：`Accept: application/json`；`User-Agent: Lambholl/galgame-savedata-sync/<APP_VERSION> (<Windows|Android>) (https://github.com/Lambholl/galgame-savedata-sync)`，四个来源相同，不带用户或设备信息。Bangumi 要求非浏览器调用方的 User-Agent 带开发者 ID 和应用名，分发的应用带版本号，开源项目带主页。下载图片时 `Accept: image/*`。
- 超时：连接 15 秒，读取 20 秒。
- 上限：JSON 响应 4 MiB，图片 20 MiB（先看 `Content-Length`，再按实际读取字节数截断）。
- 限流按来源排队：VNDB 1.55 秒、NextMoe 1.3 秒，Bangumi 和 Steam 不限；预览图并发最多 4 张。
- 错误码按来源区分网络错误、限流和格式错误，界面按错误码显示文案；底层异常只写日志，URL 去掉查询串后再写。
- 默认关键词是游戏名，去掉 `[…]`、`【…】` 和首尾空白；用户可以在搜索框里改，提交时不再处理。

## 6. 封面存储

- 下载或选中的图片在 WebView 里用 canvas 等比缩小到 `POSTER_OUTPUT` 的宽高（720×960）以内（小图不放大），用 `canvas.toBlob('image/webp', POSTER_OUTPUT.webpQuality)` 转成 WebP 后交给原生层保存；解码不了的文件提示“读不了这张图片”。两端 WebView 都基于 Chromium（Windows WebView2、Android System WebView），都能编码 WebP；同等画质下比 JPEG 小，NextMoe 的原图本身就是 WebP。显示的卡片最宽约 180px，高分屏下 720 宽也够用。
- `LibraryGame` 有可选字段 `posterHash`（封面文件内容的 SHA-256，64 位小写十六进制）和 `posterSource`（封面出处 `PosterOrigin`：四个搜索来源之一，或 `local` 表示本机图片），没有封面时都省略。字段可选，`schemaVersion` 保持 2；有 `posterHash` 没有 `posterSource` 的配置照常读取，设置行只显示尺寸。
- 文件：电脑在数据目录的 `posters/`，Android 在应用内部存储的 `posters/`，文件名 `<游戏 ID>.<posterHash>.webp`。同一个游戏换封面时新旧文件名不同，游戏库配置里的 `posterHash` 决定用哪一张。
- 保存只接受 WebP（文件头 `RIFF….WEBP`），不超过 `POSTER_LIMITS.maxSavedBytes`（1 MiB），先写临时文件再改名。
- 启动时删除游戏库没有引用的封面文件和残留的临时文件：换掉的旧封面、已移除游戏的封面、保存了文件但没写进配置的封面，都在下次启动时清掉。

两端原生层提供同样的五个方法，参数和结果按共享包的格式校验：

| 方法 | 说明 |
| --- | --- |
| `request(request)` | 执行 `PosterHttpRequest`，返回 `PosterHttpResponse`；连不上返回 `network-failure` |
| `downloadImage(url)` | 下载候选图片，返回 `{ mimeType, data }`（base64）；地址不在图片主机白名单返回 `invalid-request` |
| `pickImage()` | 电脑打开文件对话框（JPEG、PNG、WebP、GIF），Android 打开系统照片选择器；返回 `{ mimeType, data }`，取消时为 null；超过 `POSTER_LIMITS.maxImageBytes` 返回 `resource-limit` |
| `save(gameId, data)` | 保存缩放后的 WebP，返回 `posterHash`；之后由界面把 `posterHash` 写进游戏库 |
| `read(gameId, posterHash)` | 读出封面，返回 `data`；文件不存在返回 `not-found` |

界面按 `posterHash` 缓存 `blob:` URL；换封面后 hash 变化，界面换新图。

电脑端的五个方法是 `window.desktopPoster`，通道 `poster:request`、`poster:download-image`、`poster:pick-image`、`poster:save`、`poster:read`（`src/bridge/poster-bridge.ts`）。sidecar 用 `node:https` 执行请求（`poster-http.ts`）：不跟随重定向，3xx 原样交给共享包；不发 `Accept-Encoding`，响应仍被压缩时按网络失败处理；下载图片时 HTTP 404 返回 `not-found`，其他非 2xx 或 `Content-Type` 不是 `image/*` 返回 `network-failure`。选图由宿主的 `chooseImageFile` 打开文件对话框，sidecar 按扩展名定 MIME 类型后读取文件（`poster-store.ts`）。启动时在游戏库读出后、其他服务启动前清理 `posters/`。

Android 的五个方法是 Capacitor 插件 `Poster`（`PosterPlugin.java`），网页经 `platform/poster-bridge.ts` 调用。白名单、上限和超时在 `PosterRules.java` 里照抄共享包的取值，改共享包时一起改。`PosterHttp` 用 `HttpURLConnection` 执行请求，规则同电脑端：不跟随重定向，显式发 `Accept-Encoding: identity`（不写时 `HttpURLConnection` 会自己请求 gzip 并透明解压，字节上限就管不住解压后的大小），响应仍被压缩时按网络失败处理。网络请求在 4 个线程的线程池里执行，候选网格要同时下载多张预览图；封面文件读写和读取选中的图片在单个线程上串行。选图用 androidx 的 `PickVisualMedia`（只选图片），MIME 类型取 `ContentResolver.getType`，不是 JPEG、PNG、WebP、GIF 时返回 `invalid-request`。插件加载时先在文件线程上按游戏库清理 `posters/`，之后的保存排在清理后面；游戏库读不懂时不删文件。

## 7. 对端封面

- `CatalogGame` 增加 `posterHash: string | null`，目录表交换时带上；导入时把对端的 `posterSource` 一并写进本机游戏库，字段怎么带待实现时定。
- 控制通道增加请求方法 `poster.read`：参数 `{ gameId }`，应答 `{ hash, mimeType, data }`（`data` 为 base64），封面不存在时返回专门的错误。保存的封面不超过 1 MiB，base64 后远小于控制消息 8 MiB 的上限。控制通道两个方向都能发请求，监听方和拨号方导入对方的游戏走同一条路。
- `PROTOCOL_VERSION` 从 3 升到 4，两端须同版。
- 导入游戏时，对端目录表里的 `posterHash` 不为空就在保存游戏后请求封面；应答的 hash 与目录表不一致或请求失败时，游戏照常导入，用 Message 提示一次“封面未能导入”。

## 8. 界面

- `GameCard` 增加 `posterUrl`：有封面时图片铺满 3:4 区域并居中裁剪，没有时保留渐变占位和游戏名。界面按 `posterHash` 缓存读出的封面，生成 `blob:` URL；换封面后 hash 变化，换新图。
- 封面的入口只在游戏设置页：“本机存档目录”下面加“封面”一行，样式同目录行。左侧 3:4 缩略图（宽同目录行图标），右侧标题“已设置封面”或“未设置封面”，下面一行说明：有封面时是出处和原图尺寸（如“Bangumi · 720×960”，尺寸取自读出的图片），没有时是“游戏卡片显示占位图”。文字右侧排“在线搜索”“本机图片”两个按钮；有封面时行尾有菜单按钮，菜单里是“移除封面”，菜单按钮固定在行尾、不随按钮换行。移动端和设置页其他行一样不放按钮，只有行尾的菜单按钮，动作面板里是“在线搜索”“本机图片”，有封面时再加“移除封面”。行宽放不下两行文字加按钮组时（电脑端左栏约 500px，英文、日文按钮较宽；移动端竖屏），按钮组整组换到文字下面，说明并到标题后面；`PosterRow` 按标题、说明和按钮组的原本宽度判断，文字不会被挤窄。游戏操作弹窗不加入口，2×2 的操作格保持四项。
- 搜索弹层：顶部来源切换（VNDB、NextMoe、Bangumi、Steam）和关键词框，下方候选网格显示预览图、标题、副标题和 `detail`；点选候选后下载、缩放、保存并关闭，保存期间该候选显示加载、其他候选禁用。NextMoe 点选作品后进入这部作品的封面列表，标题行显示作品名和封面张数，可返回作品列表；列表里每张封面的标题都是作品名，第一行改显示封面类别（`main` 主视觉、`pkgfront` 包装正面、`pkgback` 包装背面、`pkgcontent` 包装内容、`dig` 下载版，其他值原样显示）。
- 加载中、无结果、网络错误、限流、来源出错、响应格式不符分别显示；除响应格式不符外都带“重试”（格式不符是来源接口变了，重试无用）。点关键词框的清除图标只清空，不发起搜索；关键词为空白时不搜索。
- 候选按来源返回的顺序显示，不按与关键词的字面相似度过滤或重排：游戏名常是译名，来源返回的正确结果是另一种语言的写法，字面相似度为 0（第 3 节的 13 个游戏名里，VNDB 3 个、NextMoe 6 个正确的第一条属于这种情况）。
- 电脑端 CSP 只允许本地和 `blob:` 图片，预览图经 `downloadImage` 下载后显示，同时最多 `POSTER_LIMITS.maxPreviewDownloads` 张，关闭弹层时释放；下载失败的候选显示占位。
- 电脑端用 antd Modal，移动端用底部弹层；文案四种语言。
- 保存期间弹层不能关闭；保存失败时弹层留着，可以换一张再试。移除封面只去掉游戏库里的 `posterHash`，文件在下次启动时清理。

移动端的搜索弹层是底部弹层：关键词用 SearchBar，下面是四个来源等分一行的 Tabs，结果区固定高度，候选固定三列，和游戏页网格一致；封面一行的操作都在行尾菜单按钮打开的动作面板里（见上面封面入口一条）。返回键能关闭搜索弹层和菜单，保存期间不能关。
