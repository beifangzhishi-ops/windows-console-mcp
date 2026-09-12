# Quark 后台上传工具

入口：`cloud-transfer.cmd`；WCM/PowerShell 调用建议使用 `cloud-transfer.ps1`。

要求：Windows 版夸克网盘正在运行并已登录。工具只使用本机客户端已建立的登录状态；账号映射、WSG 数据和请求密文只在内存中使用，不写入工具配置，也不输出。

默认目标由夸克客户端自己的 `manual_upload` 系统目录机制决定；当前账号对应根目录下的 **夸克上传文件**。

## 命令

```bat
cloud-transfer.cmd probe
cloud-transfer.cmd probe --json
cloud-transfer.cmd upload "C:\path\video.mp4"
cloud-transfer.cmd upload "C:\a.mp4" "D:\b.zip" --timeout 3600
cloud-transfer.cmd upload "C:\path\video.mp4" --no-wait
cloud-transfer.cmd upload "C:\path\video.mp4" --json
```

`probe` 检查 Desktop 服务、登录状态、官方 WSG 组件、当前账号映射和上传任务库。`upload` 提交后台上传并默认等待完成；只有任务状态完成、进度 100%、云端任务大小与本地文件大小一致时才返回成功。

当前版本只接受文件，不递归上传目录。Quark 客户端升级若改变内部数据结构，账号映射不唯一或无法确认时工具会直接中止，不会猜测账号。
