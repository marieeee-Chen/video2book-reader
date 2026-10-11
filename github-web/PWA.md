# iPhone 主屏幕阅读网页

静态网页保持纯阅读：书架、四类产品、主题、搜索和本机阅读位置；不装载 Agent、模型或原生能力。HTML 带 iOS 主屏幕元数据，清单和图标在 `pwa/`，支持根路径与项目子路径。图标直接复用既有原生应用 PNG，未新增第三方图片依赖。

常规 `pnpm --filter @app/github-web build` 保留原 public 内容入口。内置已验收课程时：

```bash
READER_DEMO_RELEASE=/absolute/path/to/sealed-release \
VITE_RELEASE_MANIFEST=./demo/manifest.json \
VITE_BASE=/ \
pnpm --filter @app/github-web build
```

示范模式不复制 public 工作区，先用共同的 stage-demo-content 校验冻结发布的精确文件清单/SHA，再只装入 manifest/lock 与公开正文。离线壳预缓存这些文件和安装图标，因此首次联网装配完成后，尚未点开的成品也可离线阅读。读取仍经过固定版本正文校验。API、提供者调用和 source map 不进入离线缓存。

部署 dist 到 HTTPS。在 iPhone Safari 打开，分享 → 添加到主屏幕；有“作为网页 App 打开”选项时保持开启。首次从主屏幕打开需联网，让此 Web App 自己完成缓存。浏览器或系统清理站点数据后需要重新联网缓存。

指定课程的私有访问地址和实测见 ../../acceptance/20261011-hard-brain-real/README.md。Tailscale Serve 在后台由既有守护进程提供 HTTPS，仅 tailnet 可访问；无需新的公网仓库。
