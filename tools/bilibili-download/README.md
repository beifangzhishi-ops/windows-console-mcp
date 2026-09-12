# Bilibili 下载成功经验

## 结论

当前最稳定的普通 1080P 下载链路：

`BMG 已登录的 Bilibili 会话 -> playurl API -> WCM/curl 下载 DASH 视频与音频 -> ffmpeg 无损封装`

这条链路已经在 6v1f 实测成功，不需要导出浏览器 Cookie，也不依赖 JiJiDown GUI。

## 已验证样例

- BV：`BV1c8KS6tEQY`
- 标题：`Liella! - 始まりは君の空`
- 目标清晰度：1080P（quality 80）
- 最终文件：`downloads\Liella_始まりは君の空_1080p.mp4`
- 视频：H.264，1920x1080
- 音频：AAC
- 时长：约 302.9 秒
- 合并方式：`ffmpeg -c copy`，不重新编码

## 操作流程

1. 用 BMG 当前浏览器会话请求 `https://api.bilibili.com/x/web-interface/nav`，先确认 `isLogin: true`。
2. 请求 `https://api.bilibili.com/x/web-interface/view?bvid=<BV>`，取得 CID。
3. 请求 `https://api.bilibili.com/x/player/playurl?bvid=<BV>&cid=<CID>&qn=80&fnver=0&fnval=4048&fourk=1`。
4. 从返回的 DASH 数据中选 1920x1080 视频流和 AAC 音频流。
5. 在 WCM/6v1f 用 `curl.exe` 分别下载视频和音频流；请求头至少带 Bilibili Referer 和正常浏览器 User-Agent。
6. 用 ffmpeg：`ffmpeg -i video.m4s -i audio.m4s -c copy output.mp4`。
7. 用 ffprobe 验证分辨率、编解码器和时长。
## 关键经验

- Bilibili 的旧式单文件接口在这个视频上即使请求 1080P，也会降到 720P；1080P 应走 DASH。
- BMG 的浏览器网络请求会自动带当前登录上下文，适合获取账号有权限访问的 playurl 数据。
- 标准 1080P 对该样例账号可用；1080P+、4K、8K 等更高档位若接口返回权限限制，不应绕过权限。
- DASH URL 是带签名、会过期的，拿到后应尽快交给 WCM 下载。
- 下载 DASH 媒体流本身不需要把 Cookie 导出到脚本；实测使用 signed URL + Referer + User-Agent 即可。
- 最终合并优先使用 `-c copy`，避免不必要的二次编码和质量损失。

## JiJiDown / CLI 调研结果

JiJiDown 本机安装在 `C:\Program Files\JiJiDown`。经典 WPF 版本存在登录状态，但当时界面提示登录已失效；其 EXE 入口确实接收 `string[] args`，但没有找到可靠的公开 CLI 参数文档。

JiJiDown 官方 GitHub 的 `jithon` 项目公开过可编程 gRPC 接口，默认地址为 `localhost:64000`，包含 Task、Bvideo、User、Status 等服务，可创建任务、查询清晰度、登录和导入 Cookie。该仓库现已归档，因此作为研究和备用方案，不作为当前首选。

其他可选工具：

- `yutto`：适合长期 CLI 自动化，支持二维码登录并保存认证状态，是当前较好的独立 CLI 备选。
- `Bili23-Downloader-CLI`：支持 1080P 等清晰度，但高画质通常需要配置账号认证信息。
- `BBDown`：仓库已归档，不优先。

## 工具位置

本目录是 WCM 仓库中的可选独立工具：`tools\bilibili-download`。不参与 WCM 启动，也不是 WCM 的运行依赖。

`bridge.py` 的临时 `dash_urls.json` 写入本目录；`yt-dlp.exe` 也随本目录独立保存。后续需要下载普通 1080P Bilibili 视频时，可按需复用本页“BMG -> playurl -> WCM -> ffmpeg”流程。