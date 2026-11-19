# ⚠️ manifest.json 归属与协作通知(2026-10-02)

本目录的 `manifest.json` 是**两个会话的冲突点**,请注意:

- xueqiu 本机书架(nginx :80 /reader/,任务中心已上线)使用 **89 门课**的 manifest,
  由 `/data/services/bookshelf/gen-local-manifest.mjs` 生成——已改为直接写到
  `/data/services/bookshelf/manifest.json`,构建后部署进 `reader/`,**不再经过本目录**。
- 如果你(另一个会话)在做 video2book 产出的独立部署,请使用自己的输出路径
  (例如 `github-web/dist-local/` 或独立端口),不要写本目录的 `manifest.json`,
  否则会互相覆盖(2026-10-02 14:20 发生过一次)。
- `public/courses/` 目录如果是你放的语料,请知悉:`/data/services/bookshelf/courses/`
  已有同一批内容的硬链接版本nginx 直服;两边并存不冲突,但 dist 会互相清空。

协调联系:任务中心 `/data/board/up-content-backlog.md` 与 `/data/board/README.md`。
