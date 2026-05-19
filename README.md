# Cloudflare IMAP - 邮件读取工具

**基于 Cloudflare Workers 的轻量 IMAP 邮件读取页面。**

仓库地址：https://github.com/cndaqiang/cfimapmail

## ✅ 特性

- 🌐 **网页使用**：打开页面后输入 IMAP 地址、端口、邮箱和密码即可拉取
- 📬 **最近邮件**：默认读取 INBOX 最近一批邮件，可控制数量上限
- 🧾 **完整展示元信息**：列表返回发件人、收件人、抄送、回复地址、标题、时间等字段
- ⚡ **列表轻量预览**：列表阶段只读取正文开头一小段，避免 Worker 超时
- 👆 **点击读取正文**：点击某封邮件后，再按 UID 定向读取正文
- 🧹 **HTML 转纯文本**：优先读取 `text/plain`；HTML-only 邮件会尝试转成纯文本显示，不渲染 HTML
- 🔐 **IMAPS 连接**：Worker 使用 TLS 直连 IMAP 服务，推荐 993 端口
- 💾 **本地保存**：账号信息可选保存在浏览器 localStorage
- 🚫 **无服务端存储**：Worker 不保存邮箱账号、密码或邮件内容

## 🚀 部署到 Cloudflare

### 方式一：Fork 后通过 Cloudflare Dashboard 部署

1. **Fork 本仓库**：需要 GitHub 账号，点击右上角 Fork 按钮
2. **注册 Cloudflare 账号**：访问 [dash.cloudflare.com](https://dash.cloudflare.com/sign-up)
3. **连接部署**：
   - 进入 Cloudflare Dashboard → **Workers & Pages**
   - 点击 **Create application** → **Workers** → **Import a repository**
   - 选择你 Fork 的仓库并按提示部署
4. **获取地址**：部署完成后打开 Cloudflare 分配的 Workers 地址

> 💡 这个项目使用 Cloudflare Workers 的 TCP Socket 能力连接 IMAP，建议部署为 Worker 项目。

### 方式二：Wrangler 命令行部署

```bash
wrangler deploy
```

本地开发可运行：

```bash
wrangler dev
```

或双击 `start-dev.bat`。

## 📌 使用方式

1. 打开页面，填写 IMAP 地址、端口、邮箱和密码
2. 建议使用邮箱服务商提供的“应用专用密码”
3. 选择或填写要拉取的最近邮件数量
4. 点击“拉取最近邮件”
5. 页面先显示邮件元信息和正文预览
6. 点击某封邮件后，Worker 再按 UID 拉取该邮件正文
7. 如需下次自动填充，勾选“记住本机账号和密码”

## ⚠️ 注意事项

- 当前阶段只读取邮件元信息和正文文本内容
- 优先读取 `text/plain`；如果邮件只有 HTML，会尝试读取 HTML 正文并转换为纯文本显示
- Worker 不拉取附件、图片或整封原始邮件，也不会在页面中渲染 HTML
- 第一版优先支持 IMAPS/TLS 直连，推荐端口 `993`
- 浏览器本地保存使用 localStorage，请只在可信设备上勾选保存
- 不同邮箱服务商的 IMAP 策略不同，可能需要先在邮箱设置中启用 IMAP
- Worker 只在本次请求中使用密码登录 IMAP，不在服务端持久化保存

## 📚 文档

- [使用手册](docs/usage.md)
- [技术方案](docs/architecture.md)

---

*Made with Cloudflare Workers*
