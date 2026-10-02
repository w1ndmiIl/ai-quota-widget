# Antigravity 免启动额度读取

AI_bar 1.5.6 支持在 Antigravity 关闭时读取额度。

应用优先通过 Google 的 `retrieveUserQuotaSummary` 读取 Gemini 5 小时及周额度。使用 Windows 凭据管理器中的 `gemini:antigravity` 登录记录，不读取其他账户条目，也不另存明文令牌。Windows API 的辅助进程只做只读凭据查询，不启动 Antigravity、agy 或 language server。

令牌到期或云端返回 401 时，使用已有 refresh token 向 Google 续期。OAuth 客户端必须与已保存登录的 audience 一致，参数从已安装官方程序中分块读取；这一步不执行程序。新的 access token 仅缓存在内存，不改写 Antigravity 自己的登录状态。账号更换后清除内存中的旧令牌和客户端匹配。

接口失败时尝试已经运行的本地服务；都不可用时保留原额度与原更新时间并附带读取错误。没有历史额度时显示错误。不会再短暂启动后台服务，也不会发送模型请求、消耗 AI credits 或使用重置卡。

源码服务和打包后的 Electron 模块已验证云端读取、令牌续期以及续期后的再次查询，读取路径为 `oauth`，全程无需启动 Antigravity。缓存仅保存来源、模型组、额度窗口、更新时间和读取路径，不保存凭据。

只接受含实际剩余比例的 Gemini 额度 bucket；模型列表、空值、布尔值、越界比例不会被当作“100% 可用”。网络请求限制响应大小并设置总截止时间，不跟随重定向。

该额度协议属于内部接口，字段可能变化。登录被撤销或权限变化时需要在官方客户端重新登录，读取失败继续保留缓存。

核对依据：[免启动云端实现](https://docs.rs/quotas/latest/src/quotas/providers/antigravity.rs.html)、[CodexBar OAuth 与额度汇总说明](https://github.com/steipete/CodexBar/blob/main/docs/antigravity.md)、[Google OAuth 续期](https://developers.google.com/identity/protocols/oauth2/native-app#offline)、[Windows CredReadW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw)。
