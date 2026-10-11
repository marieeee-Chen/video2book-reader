# 本地实施与运行（2026-10-11）

当前代码将阅读器、通用会话、插件、能力端口和三端装配分开。静态站只导入 shared reading 与 reader，不导入 Agent、学习插件或模型适配器。完整证据、状态及剩余验收见同级工作区 `../acceptance/20261011-implementation/README.md`。

## 运行入口

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm check
pnpm verify:boundaries
pnpm dev:web
pnpm dev
pnpm dev:mobile
```

`pnpm check` 使用五份固定上游回归样本；不是全库编辑审核。`pnpm audit:split` 扫描同级课程仓，当前有 48 条存量结构告警。环境变量 `SPLIT_AUDIT_REPORT` 可输出含逐文件哈希的 JSON。`check:render` 默认同级课程仓，CI 使用固定样本。

正式默认消费 manifest v3；不兼容清单给升级/版本错误，不回退到实时 main。开发旧 v2 预览必须显式设置 `VITE_CONTENT_MODE=preview`，不能作为正式锁定发布。保留旧 GitHubSource 只用于该隔离预览。

正式静态产物由发布协调仓冻结，再与内容同批部署。本地书架用协调仓 `serve.py` 运行 acceptance/local-host；直接 vite dev 需为 manifest 与 versions URL 配置同源宿主。禁止把工作区正文链接进正式站。

桌面/安卓构建通过 `VITE_RELEASE_MANIFEST=https://自己的书架/manifest.json` 选定内容宿主；UI 的模型端点与书架内容源分别配置。Android 本地演示要用设备可达的宿主地址，回环地址不代表开发机。桌面原生还有“打开本地资料”，选择整个冻结发布目录，经目录句柄与逐文件 SHA 读取；不存在任意路径读取工具。

## 会话与插件

`packages/agent` 只认通用 scope、未知 binding、Item/Turn/Thread，不含章、册、QuoteRef。`packages/plugin` 拥有六类可逆注册与延迟激活；setup 失败和卸载逆序清理，关闭过程中完成的加载也撤销贡献。假想第二业务插件的 scope/binding 回归无需修改核心。

`plugins/study` 注册 13 个初版技能和四个只读工具。章会话绑定文档 UID、正文 SHA、章节 SHA 与模型身份；元数据更新续用，正文变化开新会话并保留旧史。册首/导读不伪装为第一章。划词引用由业务插件捕获、保存为不透明消息附件，在原用户消息重放，不进入 system 前缀。记忆卡的翻面是同线程的显式后续请求。

用户在设置选择 Chat Completions、Anthropic Messages 或 Google Native 并输入自定义端点、模型与密钥。前两者接受服务基址或完整请求路径；Google 输入版本 API 基址（例如 `https://generativelanguage.googleapis.com/v1beta`），模型字段输入模型名。地址不允许包含凭据/query/hash，密钥使用独立 SecretPort。模型/协议/端点改动更换模型身份，密钥轮换保留身份；一条线程固定一个模型。当前 UI 一次启用一个自定义模型。

工具轮上限 16；用户停止贯穿首字节、上下文和工具阶段，无自动重试。只读工具可安全并行，结果按调用顺序回放。已展示的部分输出保留，错误/中止明确标记。缓存数据缺失显示“未知”；内存前缀诊断不伪装为真实缓存命中率。

学习插件可在桌面/安卓外壳中卸载；卸载后引用监听器、技能、上下文和工具都消失，仍能阅读和使用空白通用会话。构建插件移除检查分别构建三端，随后完整前端产物必须重新 build。

## 内容、离线与本地状态

每个 ContentSource 实例固定一个发布，缓存键使用 UID+SHA，每次取正文/图片都校验字节；远端回退仅用逐文档声明的仓和固定提交。书架索引仅在网络失败时可用已验证缓存，在线返回坏/不兼容清单不会偷偷选旧版。

静态 service worker 保全当前阅读外壳、已读版本化正文和图片，不缓存模型请求或 API。首访仍需联网，未读资料和未下载图片不保证离线可用。阅读位置绑定正文版本，失效保留旧位置并回退章首。ZIP 收集已声明资产；缺图片/外部图会标记不完整。

会话/模型元数据使用 IndexedDB StorePort。桌面 Stronghold 的随机主密码只交给 OS credential store；安卓密钥使用 AndroidKeyStore AES-GCM 与私有加密 prefs。浏览器开发壳的密钥只在当前运行内存，不能当作原生持久化验收。阅读事件默认关闭，只有显式 `VITE_READING_EVENTS=enabled` 并部署同源接收服务才上报版本字段；本轮未部署事件接收器。

## 原生构建与验收

```bash
# Windows：安装 MSVC/Rust/WebView2 后，从 reader 根目录运行。
pnpm --filter @app/desktop exec tauri build
# Android：JDK 21、Android SDK 36。
pnpm build:mobile
pnpm --filter @app/mobile android:sync
cd apps/mobile/android
./gradlew assembleDebug
```

已实现的原生接缝包括桌面逐块 HTTP、中止、Stronghold、AppData 文件、托盘/隐藏恢复、用户选择本地资料；安卓逐块 HTTP/中止、自定义 Keystore 插件和 filesystem。`android:sync` 自动覆盖本仓原生插件模板并注册，不能只使用 Capacitor 的整包响应 HTTP 代替增量流。

updater 默认 feature 关闭。使用 `scripts/updater-config.mjs` 生成公钥/端点权限配置，设置 `READER_UPDATE_URL` / `READER_UPDATER_PUBLIC_KEY`，再带 `--features updater` 构建；签名私钥不入仓。只有具备签名更新源后才验安装升级，当前不能声称更新成功。

当前 Linux 工作区缺 Rust 编译器、JDK、Android SDK 和设备。Cargo.lock 已解析更新、Android 工程已生成与同步、三端前端已构建；Windows NSIS / 原生 Rust、安卓 APK / 真机、vault 锁定恢复与真实提供者尚未验收。CI 合同工作流和手动原生候选构建工作流已写入，尚未推送或运行。

目标设备须逐项归档：真实逐字流、首字节前/中途停止、工具往返、重启恢复线程/密钥、密钥删除与 vault 锁定、离线阅读、托盘恢复；Windows 新装/重装与签名升级；Android WebView/小屏/后台恢复。编译产物不代替这些运行证据。

实现参考：[Tauri 原生构建流水线](https://v2.tauri.app/distribute/pipelines/github/)、[Tauri Stronghold](https://v2.tauri.app/plugin/stronghold/)、[Tauri updater](https://v2.tauri.app/plugin/updater/)、[Capacitor Android](https://capacitorjs.com/docs/android)、[Capacitor 8 升级要求](https://capacitorjs.com/docs/updating/8-0)。
