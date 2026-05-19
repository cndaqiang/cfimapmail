# 技术方案与数据流

## 架构组件

- **Worker 入口**：负责页面渲染、健康检查、邮件列表 API 和单封正文 API
- **IMAP 客户端**：在 Worker 中使用 TCP socket 连接 IMAP 服务器
- **前端页面**：收集账号信息、调用 API、渲染邮件列表和正文、本地保存配置

## 路由说明

| 路由 | 说明 |
| --- | --- |
| `/` | 首页，呈现 IMAP 表单和邮件列表 |
| `/api/fetch` | POST 接口，读取最近 N 封邮件的元信息和 plain text 小预览 |
| `/api/message` | POST 接口，按 UID 读取某一封邮件的 plain text 正文 |
| `/health` | 健康检查接口 |

## 数据流

### 1. 列表阶段

1. 用户在浏览器输入 IMAP 地址、端口、邮箱、密码和拉取数量
2. 前端通过 `POST /api/fetch` 提交到 Worker
3. Worker 使用 TLS TCP socket 连接 IMAP 服务器
4. Worker 执行 `LOGIN`、`SELECT INBOX`
5. Worker 根据 `EXISTS` 和数量上限计算最近 N 封邮件范围
6. Worker 执行：

```text
FETCH <range> (UID BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (FROM TO CC BCC REPLY-TO SENDER SUBJECT DATE MESSAGE-ID)])
```

7. Worker 解析邮件展示元信息和 `BODYSTRUCTURE`
8. Worker 从 `BODYSTRUCTURE` 中定位第一个 `text/plain` part
9. 对每封存在 plain text 的邮件，只读取正文开头一小段：

```text
UID FETCH <uid> (BODY.PEEK[<plainPart>]<0.2048>)
```

10. Worker 返回列表 JSON 给浏览器
11. 前端渲染元信息和 plain text 预览

### 2. 正文阶段

1. 用户点击某一封邮件
2. 前端通过 `POST /api/message` 提交 IMAP 配置和邮件 UID
3. Worker 登录 IMAP 并重新选择 INBOX
4. Worker 按 UID 拉取该邮件元信息和 MIME 结构：

```text
UID FETCH <uid> (BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (FROM TO CC BCC REPLY-TO SENDER SUBJECT DATE MESSAGE-ID)])
```

5. Worker 定位 `text/plain` part
6. Worker 只读取该 plain text part 的正文前 64KB：

```text
UID FETCH <uid> (BODY.PEEK[<plainPart>]<0.65536>)
```

7. Worker 解码 plain text 并返回浏览器
8. 前端展开卡片，使用 `textContent` 和 `white-space: pre-wrap` 显示正文

## 本地存储

浏览器使用两个 key：

```text
cfmail_imap.account
cfmail_imap.password
```

Worker 不保存账号、密码或邮件内容。

## IMAP 范围

当前实现的最小 IMAP 能力：

- TLS 直连 IMAP，推荐端口 993
- `LOGIN`
- `SELECT INBOX`
- `FETCH` / `UID FETCH`
- `BODYSTRUCTURE` 定位 `text/plain`
- `BODY.PEEK[HEADER.FIELDS (...)]` 读取指定元信息
- `BODY.PEEK[part]<offset.count>` 按 MIME part 和字节范围读取 plain text
- 解析常见 From、To、Cc、Reply-To、Sender、Subject、Date、Message-ID
- 解码常见 MIME header、base64、quoted-printable 和部分 charset

## 读取边界

当前阶段只读取：

- 邮件展示元信息
- MIME 结构
- plain text 预览
- 点击后的 plain text 正文

当前阶段不读取或处理：

- 附件
- 图片
- HTML 正文
- 整封原始邮件

## 限制

- 不完整支持复杂 MIME 邮件
- 不支持附件下载
- 不渲染 HTML-only 邮件
- 不默认支持 STARTTLS 或 OAuth
- 单封正文默认最多读取 64KB，后续可扩展 offset 分段继续读取
- 不同邮箱服务商可能需要应用专用密码或额外开启 IMAP
