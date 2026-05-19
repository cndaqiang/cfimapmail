import { connect } from 'cloudflare:sockets';

const DEFAULT_MESSAGE_LIMIT = 20;
const MAX_MESSAGE_LIMIT = 50;
const PREVIEW_BYTES = 2048;
const BODY_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 20000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export default {
  async fetch(request) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;

      if (request.method === 'OPTIONS') {
        return createJSONResponse({ ok: true });
      }

      if (pathname === '/health') {
        return createJSONResponse({ status: 'ok', timestamp: new Date().toISOString() });
      }

      if (pathname === '/api/fetch' && request.method === 'POST') {
        return await handleFetchMessages(request);
      }

      if (pathname === '/api/message' && request.method === 'POST') {
        return await handleFetchMessage(request);
      }

      if (pathname === '/') {
        return createHomeResponse();
      }

      return createErrorResponse('Not Found', 404, 'Supported routes: /, /api/fetch, /health');
    } catch (error) {
      return createErrorResponse('Internal Server Error', 500, error.message);
    }
  }
};

async function handleFetchMessages(request) {
  const payload = await request.json().catch(() => null);
  const config = normalizeConfig(payload || {});
  const messages = await withTimeout(fetchLatestMessages(config), COMMAND_TIMEOUT_MS, '连接或读取 IMAP 超时');
  return createJSONResponse({ messages });
}

async function handleFetchMessage(request) {
  const payload = await request.json().catch(() => null);
  const config = normalizeConfig(payload || {});
  const uid = normalizeUid((payload || {}).uid);
  const message = await withTimeout(fetchMessageBody(config, uid), COMMAND_TIMEOUT_MS, '连接或读取 IMAP 超时');
  return createJSONResponse(message);
}

function normalizeConfig(payload) {
  const host = String(payload.host || '').trim();
  const email = String(payload.email || '').trim();
  const password = String(payload.password || '');
  const port = Number(payload.port || 993);
  const rawLimit = Number(payload.limit || DEFAULT_MESSAGE_LIMIT);

  if (!host) {
    throw new Error('请填写 IMAP 地址');
  }
  if (!/^[a-z0-9.-]+$/i.test(host) || host.startsWith('.') || host.endsWith('.')) {
    throw new Error('IMAP 地址格式不正确');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口必须是 1-65535 之间的整数');
  }
  if (!email) {
    throw new Error('请填写邮箱');
  }
  if (!password) {
    throw new Error('请填写密码或应用专用密码');
  }

  const limit = Number.isInteger(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_MESSAGE_LIMIT)
    : DEFAULT_MESSAGE_LIMIT;

  return { host, port, email, password, limit };
}

function normalizeUid(value) {
  const uid = String(value || '').trim();
  if (!/^\d+$/.test(uid)) {
    throw new Error('邮件 UID 不正确');
  }
  return uid;
}

async function fetchLatestMessages(config) {
  const session = await openImapSession(config);
  const { socket, reader, writer } = session;
  let tagIndex = session.tagIndex;

  try {
    const exists = await selectInbox(writer, reader, tagIndex++);
    if (!exists) {
      await logout(writer, reader, tagIndex++);
      return [];
    }

    const start = Math.max(1, exists - config.limit + 1);
    const range = `${start}:${exists}`;
    const metaCommand = `FETCH ${range} (UID BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (FROM TO CC BCC REPLY-TO SENDER SUBJECT DATE MESSAGE-ID CONTENT-TYPE)])`;
    await sendCommand(writer, tagIndex++, metaCommand);
    const metaLines = await readTaggedResponse(reader, tagIndex - 1, '读取邮件信息失败');
    const messages = parseMessageMetadata(metaLines).slice(-config.limit);

    for (const message of messages) {
      if (!message.plainPart) {
        message.preview = '';
        continue;
      }
      const previewCommand = `UID FETCH ${message.uid} (BODY.PEEK[${message.plainPart}]<0.${PREVIEW_BYTES}>)`;
      await sendCommand(writer, tagIndex++, previewCommand);
      const previewLines = await readTaggedResponse(reader, tagIndex - 1, '读取邮件预览失败');
      const rawPreview = extractFetchLiteral(previewLines);
      message.preview = createPreview(decodePlainTextBody(rawPreview, message));
    }

    await logout(writer, reader, tagIndex++);

    return messages.reverse().map(toPublicMessage);
  } finally {
    writer.releaseLock();
    reader.releaseLock();
    socket.close();
  }
}

async function fetchMessageBody(config, uid) {
  const session = await openImapSession(config);
  const { socket, reader, writer } = session;
  let tagIndex = session.tagIndex;

  try {
    await selectInbox(writer, reader, tagIndex++);

    const metaCommand = `UID FETCH ${uid} (BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (FROM TO CC BCC REPLY-TO SENDER SUBJECT DATE MESSAGE-ID CONTENT-TYPE)])`;
    await sendCommand(writer, tagIndex++, metaCommand);
    const metaLines = await readTaggedResponse(reader, tagIndex - 1, '读取邮件信息失败');
    const message = parseSingleMessageMetadata(metaLines, uid);

    if (!message.plainPart) {
      await logout(writer, reader, tagIndex++);
      return {
        ...toPublicMessage(message),
        body: '',
        hasPlainText: false,
        truncated: false,
        message: '未找到 plain text 正文'
      };
    }

    const bodyCommand = `UID FETCH ${uid} (BODY.PEEK[${message.plainPart}]<0.${BODY_BYTES}>)`;
    await sendCommand(writer, tagIndex++, bodyCommand);
    const bodyLines = await readTaggedResponse(reader, tagIndex - 1, '读取邮件正文失败');
    const rawBody = extractFetchLiteral(bodyLines);
    const body = decodePlainTextBody(rawBody, message);

    await logout(writer, reader, tagIndex++);

    return {
      ...toPublicMessage(message),
      body,
      hasPlainText: true,
      truncated: rawBody.length >= BODY_BYTES
    };
  } finally {
    writer.releaseLock();
    reader.releaseLock();
    socket.close();
  }
}

async function openImapSession(config) {
  const socket = connect(
    { hostname: config.host, port: config.port },
    { secureTransport: 'on' }
  );
  const reader = new ImapReader(socket.readable.getReader());
  const writer = socket.writable.getWriter();
  let tagIndex = 1;

  try {
    const greeting = await reader.readLine();
    if (!greeting.startsWith('* OK')) {
      throw new Error('IMAP 服务器未返回可用的欢迎信息');
    }

    await sendCommand(writer, tagIndex++, `LOGIN ${quoteImapString(config.email)} ${quoteImapString(config.password)}`);
    await readTaggedResponse(reader, tagIndex - 1, '登录失败，请检查邮箱和密码');

    return { socket, reader, writer, tagIndex };
  } catch (error) {
    writer.releaseLock();
    reader.releaseLock();
    socket.close();
    throw error;
  }
}

async function selectInbox(writer, reader, tagIndex) {
  await sendCommand(writer, tagIndex, 'SELECT INBOX');
  const selectLines = await readTaggedResponse(reader, tagIndex, '无法打开 INBOX');
  return parseExists(selectLines);
}

async function logout(writer, reader, tagIndex) {
  await sendCommand(writer, tagIndex, 'LOGOUT');
  await readTaggedResponse(reader, tagIndex, '退出失败').catch(() => []);
}

async function sendCommand(writer, tagIndex, command) {
  const tag = formatTag(tagIndex);
  await writer.write(textEncoder.encode(`${tag} ${command}\r\n`));
}

async function readTaggedResponse(reader, tagIndex, failureMessage) {
  const tag = formatTag(tagIndex);
  const lines = [];

  while (true) {
    const line = await reader.readLine();
    lines.push(line);

    const literalSize = parseLiteralSize(line);
    if (literalSize !== null) {
      const literal = await reader.readBytes(literalSize);
      lines.push(textDecoder.decode(literal));
      await reader.consumeLineBreak();
    }

    if (line.startsWith(tag + ' ')) {
      if (!line.toUpperCase().startsWith(tag + ' OK')) {
        throw new Error(extractImapError(line, failureMessage));
      }
      return lines;
    }
  }
}

function formatTag(tagIndex) {
  return 'A' + String(tagIndex).padStart(4, '0');
}

function parseLiteralSize(line) {
  const match = line.match(/\{(\d+)\}$/);
  return match ? Number(match[1]) : null;
}

function parseExists(lines) {
  for (const line of lines) {
    const match = line.match(/^\*\s+(\d+)\s+EXISTS/i);
    if (match) return Number(match[1]);
  }
  return 0;
}

function parseMessageMetadata(lines) {
  const messages = [];
  let current = null;
  let expectHeader = false;

  for (const line of lines) {
    const fetchMatch = line.match(/^\*\s+(\d+)\s+FETCH\s+\((.*)$/i);
    if (fetchMatch) {
      current = {
        sequence: Number(fetchMatch[1]),
        uid: '',
        header: '',
        bodyStructure: ''
      };
      messages.push(current);
      applyFetchMetadata(current, line);
      expectHeader = /BODY\[HEADER\.FIELDS/i.test(line) && parseLiteralSize(line) !== null;
      continue;
    }

    if (!current) continue;

    if (expectHeader) {
      current.header = line;
      expectHeader = false;
      continue;
    }

    applyFetchMetadata(current, line);
    if (/BODY\[HEADER\.FIELDS/i.test(line) && parseLiteralSize(line) !== null) {
      expectHeader = true;
    }
  }

  return messages
    .filter((item) => item.uid || item.header)
    .map((item) => buildMessageMetadata(item));
}

function parseSingleMessageMetadata(lines, fallbackUid) {
  const messages = parseMessageMetadata(lines);
  return messages.find((item) => item.uid === fallbackUid) || messages[0] || {
    uid: fallbackUid,
    from: '',
    to: '',
    cc: '',
    bcc: '',
    replyTo: '',
    sender: '',
    subject: '无主题',
    date: '',
    messageId: '',
    preview: '',
    hasPlainText: false,
    plainPart: '',
    charset: 'utf-8',
    transferEncoding: ''
  };
}

function applyFetchMetadata(current, line) {
  const uidMatch = line.match(/\bUID\s+(\d+)/i);
  if (uidMatch) current.uid = uidMatch[1];

  const bodyStructureMatch = line.match(/BODYSTRUCTURE\s+([\s\S]*?)(?:\s+BODY\[|\s+UID\s+\d+|\)\s*$)/i);
  if (bodyStructureMatch) current.bodyStructure = trimFetchValue(bodyStructureMatch[1]);
}

function buildMessageMetadata(item) {
  const headers = parseHeaders(item.header || '');
  const plainInfo = findPlainTextPart(item.bodyStructure || '');
  const fallbackInfo = findHtmlTextPart(item.bodyStructure || '', headers);
  return {
    uid: item.uid || String(item.sequence || ''),
    from: decodeMimeWords(headers.from || ''),
    to: decodeMimeWords(headers.to || ''),
    cc: decodeMimeWords(headers.cc || ''),
    bcc: decodeMimeWords(headers.bcc || ''),
    replyTo: decodeMimeWords(headers['reply-to'] || ''),
    sender: decodeMimeWords(headers.sender || ''),
    subject: decodeMimeWords(headers.subject || '无主题'),
    date: normalizeDate(headers.date),
    messageId: headers['message-id'] || '',
    preview: '',
    hasPlainText: Boolean(plainInfo.part || fallbackInfo.part),
    plainPart: plainInfo.part || fallbackInfo.part,
    charset: plainInfo.charset || fallbackInfo.charset || 'utf-8',
    transferEncoding: plainInfo.encoding || fallbackInfo.encoding || '',
    isHtmlFallback: Boolean(!plainInfo.part && fallbackInfo.part)
  };
}

function findHtmlTextPart(bodyStructure, headers = {}) {
  const value = String(bodyStructure || '');
  const htmlPattern = /\(\s*"TEXT"\s+"HTML"/gi;
  const match = htmlPattern.exec(value);
  if (match) {
    const section = readParenthesized(value, match.index);
    return {
      part: inferPartNumber(value.slice(0, match.index)),
      charset: extractBodyParam(section, 'CHARSET') || 'utf-8',
      encoding: extractTransferEncoding(section),
      isHtml: true
    };
  }

  const contentType = String(headers['content-type'] || '');
  if (/^\s*text\/html\b/i.test(contentType)) {
    return {
      part: 'TEXT',
      charset: extractHeaderParam(contentType, 'charset') || 'utf-8',
      encoding: headers['content-transfer-encoding'] || 'quoted-printable',
      isHtml: true
    };
  }

  return { part: '', charset: 'utf-8', encoding: '', isHtml: false };
}

function findHeaderPlainTextPart(headers) {
  const contentType = String(headers['content-type'] || '');
  if (!/^\s*text\/html\b/i.test(contentType)) {
    return { part: '', charset: 'utf-8', encoding: '' };
  }
  return {
    part: '1',
    charset: extractHeaderParam(contentType, 'charset') || 'utf-8',
    encoding: 'quoted-printable'
  };
}

function extractHeaderParam(value, name) {
  const pattern = new RegExp('(?:^|;)\\s*' + name + '\\s*=\\s*(?:"([^"]+)"|([^;]+))', 'i');
  const match = String(value || '').match(pattern);
  return match ? String(match[1] || match[2] || '').trim() : '';
}

function trimFetchValue(value) {
  return String(value || '').replace(/\s+\)$/g, '').trim();
}

function readParenthesized(value, startIndex) {
  let depth = 0;
  let inQuote = false;
  let escaped = false;

  for (let i = startIndex; i < value.length; i++) {
    const char = value[i];

    if (inQuote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inQuote = false;
      }
      continue;
    }

    if (char === '"') {
      inQuote = true;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return value.slice(startIndex, i + 1);
    }
  }

  return value.slice(startIndex);
}

function findPlainTextPart(bodyStructure) {
  const value = String(bodyStructure || '');
  if (!value) return { part: '', charset: 'utf-8', encoding: '' };

  const textPlainPattern = /\("TEXT"\s+"PLAIN"[\s\S]*?\)/gi;
  let match;
  while ((match = textPlainPattern.exec(value))) {
    const before = value.slice(0, match.index);
    const part = inferPartNumber(before);
    const section = match[0];
    return {
      part,
      charset: extractBodyParam(section, 'CHARSET') || 'utf-8',
      encoding: extractTransferEncoding(section)
    };
  }

  if (/^\("TEXT"\s+"PLAIN"/i.test(value)) {
    return {
      part: 'TEXT',
      charset: extractBodyParam(value, 'CHARSET') || 'utf-8',
      encoding: extractTransferEncoding(value)
    };
  }

  return { part: '', charset: 'utf-8', encoding: '' };
}

function inferPartNumber(before) {
  const stack = [];
  for (let i = 0; i < before.length; i++) {
    const char = before[i];
    if (char === '(') {
      stack.push(0);
    } else if (char === ')') {
      stack.pop();
    } else if (char === '"' && /^"[A-Z]+"\s+"[A-Z0-9.+-]+"/i.test(before.slice(i))) {
      if (stack.length) stack[stack.length - 1] += 1;
      i = skipQuotedPair(before, i);
    }
  }
  const parts = stack.filter((value) => value > 0);
  return parts.length ? parts.join('.') : '1';
}

function skipQuotedPair(value, index) {
  let quoteCount = 0;
  for (let i = index; i < value.length; i++) {
    if (value[i] === '"' && value[i - 1] !== '\\') {
      quoteCount += 1;
      if (quoteCount === 4) return i;
    }
  }
  return index;
}

function extractBodyParam(section, name) {
  const pattern = new RegExp('"' + name + '"\\s+"([^"]+)"', 'i');
  const match = String(section || '').match(pattern);
  return match ? match[1] : '';
}

function extractTransferEncoding(section) {
  const quoted = Array.from(String(section || '').matchAll(/"([^"]*)"/g)).map((item) => item[1]);
  return quoted[4] || '';
}

function extractFetchLiteral(lines) {
  for (let i = 0; i < lines.length - 1; i++) {
    if (/BODY\[[^\]]*\](?:<\d+>)?\s+\{\d+\}$/i.test(lines[i])) {
      return lines[i + 1] || '';
    }
  }
  return '';
}

function decodePlainTextBody(raw, metadata) {
  if (!raw) return '';
  const encoding = String(metadata.transferEncoding || '').toLowerCase();
  const charset = metadata.charset || 'utf-8';
  let decoded = raw;

  try {
    if (encoding === 'base64') {
      decoded = decodeBytes(base64ToBytes(raw.replace(/\s+/g, '')), charset);
    } else if (encoding === 'quoted-printable') {
      decoded = decodeBytes(quotedPrintableToBytes(raw), charset);
    }
  } catch (error) {
    decoded = raw;
  }

  return metadata.isHtmlFallback ? htmlToText(decoded) : decoded;
}

function htmlToText(value) {
  return String(value || '')
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|section|article|header|footer|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toPublicMessage(message) {
  return {
    uid: message.uid,
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    replyTo: message.replyTo,
    sender: message.sender,
    subject: message.subject,
    date: message.date,
    messageId: message.messageId,
    preview: message.preview || '',
    hasPlainText: Boolean(message.hasPlainText)
  };
}

function parseHeaders(raw) {
  const headers = {};
  const unfolded = raw.replace(/\r?\n[\t ]+/g, ' ');
  const lines = unfolded.split(/\r?\n/);
  for (const line of lines) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers[key] = value;
  }
  return headers;
}

function normalizeDate(value) {
  if (!value) return '';
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? value : new Date(timestamp).toISOString();
}

function createPreview(raw) {
  if (!raw) return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function decodeMimeWords(value) {
  return String(value).replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (match, charset, encoding, text) => {
    try {
      const bytes = encoding.toLowerCase() === 'b'
        ? base64ToBytes(text)
        : quotedPrintableToBytes(text.replace(/_/g, ' '));
      return decodeBytes(bytes, charset);
    } catch (error) {
      return match;
    }
  });
}

function decodeBase64Text(value) {
  try {
    return decodeBytes(base64ToBytes(value), 'utf-8');
  } catch (error) {
    return '';
  }
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function quotedPrintableToBytes(value) {
  const normalized = String(value || '').replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] === '=' && /^[0-9a-f]{2}$/i.test(normalized.slice(i + 1, i + 3))) {
      bytes.push(parseInt(normalized.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(normalized.charCodeAt(i));
    }
  }
  return new Uint8Array(bytes);
}

function decodeBytes(bytes, charset) {
  const normalized = String(charset || 'utf-8').toLowerCase();
  const label = normalized === 'gb2312' || normalized === 'gbk' ? 'gb18030' : normalized;
  return new TextDecoder(label).decode(bytes);
}

function quoteImapString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function extractImapError(line, fallback) {
  return line.replace(/^A\d+\s+(NO|BAD)\s*/i, '').trim() || fallback;
}

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class ImapReader {
  constructor(reader) {
    this.reader = reader;
    this.buffer = new Uint8Array(0);
  }

  async readLine() {
    while (true) {
      const index = findLineBreak(this.buffer);
      if (index >= 0) {
        const line = this.buffer.slice(0, index);
        const skip = this.buffer[index] === 13 && this.buffer[index + 1] === 10 ? 2 : 1;
        this.buffer = this.buffer.slice(index + skip);
        return textDecoder.decode(line);
      }
      await this.readMore();
    }
  }

  async readBytes(length) {
    while (this.buffer.length < length) {
      await this.readMore();
    }
    const bytes = this.buffer.slice(0, length);
    this.buffer = this.buffer.slice(length);
    return bytes;
  }

  async consumeLineBreak() {
    while (this.buffer.length < 1) {
      await this.readMore();
    }
    if (this.buffer[0] === 13 && this.buffer[1] === 10) {
      this.buffer = this.buffer.slice(2);
    } else if (this.buffer[0] === 10) {
      this.buffer = this.buffer.slice(1);
    }
  }

  async readMore() {
    const { value, done } = await this.reader.read();
    if (done) {
      throw new Error('IMAP 连接已关闭');
    }
    const next = new Uint8Array(this.buffer.length + value.length);
    next.set(this.buffer, 0);
    next.set(value, this.buffer.length);
    this.buffer = next;
  }

  releaseLock() {
    this.reader.releaseLock();
  }
}

function findLineBreak(buffer) {
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 10) {
      return i > 0 && buffer[i - 1] === 13 ? i - 1 : i;
    }
  }
  return -1;
}

function createJSONResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    }
  });
}

function createErrorResponse(message, status = 500, details = null) {
  const error = {
    error: message,
    code: status,
    timestamp: new Date().toISOString()
  };

  if (details) {
    error.details = details;
  }

  return createJSONResponse(error, status);
}

function createHomeResponse() {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloudflare IMAP</title>
  <style>
    :root {
      --bg: #0f172a;
      --panel: #111827;
      --card: #1f2937;
      --text: #e5e7eb;
      --muted: #94a3b8;
      --border: #334155;
      --accent: #38bdf8;
      --accent-2: #22c55e;
      --danger: #fb7185;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at top, #1e3a8a 0, var(--bg) 45%);
      color: var(--text);
    }

    .app {
      width: min(1080px, 100%);
      margin: 0 auto;
      padding: 32px 16px;
    }

    .hero {
      text-align: center;
      margin-bottom: 24px;
    }

    .hero h1 {
      margin: 0 0 8px;
      font-size: clamp(30px, 6vw, 52px);
    }

    .hero p {
      margin: 0;
      color: var(--muted);
    }

    .layout {
      display: grid;
      grid-template-columns: 360px 1fr;
      gap: 18px;
    }

    .panel {
      background: rgba(17, 24, 39, 0.9);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
    }

    .field { margin-bottom: 14px; }

    label {
      display: block;
      margin-bottom: 6px;
      color: var(--muted);
      font-size: 14px;
    }

    input {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      color: var(--text);
      background: #0b1120;
      outline: none;
    }

    input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.14);
    }

    .row {
      display: grid;
      grid-template-columns: 1fr 110px 110px;
      gap: 10px;
    }

    .checkbox {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 6px 0 16px;
      color: var(--muted);
      font-size: 14px;
    }

    .checkbox input { width: auto; }

    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    .btn {
      border: 0;
      border-radius: 12px;
      padding: 11px 14px;
      color: #03121f;
      cursor: pointer;
      font-weight: 700;
    }

    .btn.primary { background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .btn.secondary { background: #334155; color: var(--text); }
    .btn:disabled { cursor: not-allowed; opacity: 0.65; }

    .notice {
      min-height: 22px;
      margin-top: 14px;
      color: var(--accent);
      font-size: 14px;
    }

    .tips {
      margin-top: 14px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.6;
    }

    .messages {
      display: grid;
      gap: 12px;
    }

    .mail {
      background: rgba(31, 41, 55, 0.85);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 14px;
      cursor: pointer;
      transition: border-color 0.15s ease, background 0.15s ease;
    }

    .mail.open {
      border-color: var(--accent);
      background: rgba(31, 41, 55, 0.98);
    }

    .mail h3 {
      margin: 0 0 8px;
      font-size: 18px;
      color: #f8fafc;
      word-break: break-word;
    }

    .meta {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 10px;
      color: var(--muted);
      font-size: 13px;
    }

    .preview {
      margin: 0;
      color: #cbd5e1;
      line-height: 1.6;
      word-break: break-word;
    }

    .meta-line {
      margin: 4px 0;
      color: var(--muted);
      font-size: 13px;
      word-break: break-word;
    }

    .meta-line strong {
      color: #cbd5e1;
      font-weight: 600;
    }

    .body {
      display: none;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
      color: #e2e8f0;
      line-height: 1.65;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .mail.open .body { display: block; }
    .body.loading, .body.empty { color: var(--muted); }

    .empty {
      padding: 40px 20px;
      color: var(--muted);
      text-align: center;
      border: 1px dashed var(--border);
      border-radius: 16px;
    }

    .error { color: var(--danger); }

    .footer {
      margin-top: 20px;
      text-align: center;
      color: var(--muted);
      font-size: 13px;
    }

    @media (max-width: 820px) {
      .layout { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="app">
    <div class="hero">
      <h1>Cloudflare IMAP</h1>
      <p>通过 Cloudflare Workers 拉取最近邮件的元信息和 plain text 预览，点击后再读取正文。</p>
    </div>

    <div class="layout">
      <section class="panel">
        <div class="field">
          <label for="hostInput">IMAP 地址</label>
          <input id="hostInput" autocomplete="off" placeholder="imap.example.com">
        </div>
        <div class="row">
          <div class="field">
            <label for="emailInput">邮箱</label>
            <input id="emailInput" type="email" autocomplete="username" placeholder="name@example.com">
          </div>
          <div class="field">
            <label for="portInput">端口</label>
            <input id="portInput" type="number" min="1" max="65535" value="993">
          </div>
          <div class="field">
            <label for="limitInput">数量</label>
            <input id="limitInput" type="number" min="1" max="50" value="20">
          </div>
        </div>
        <div class="field">
          <label for="passwordInput">密码 / 应用专用密码</label>
          <input id="passwordInput" type="password" autocomplete="current-password" placeholder="建议使用应用专用密码">
        </div>
        <label class="checkbox">
          <input id="rememberInput" type="checkbox">
          <span>记住本机账号和密码</span>
        </label>
        <div class="actions">
          <button id="fetchBtn" class="btn primary" type="button">拉取最近邮件</button>
          <button id="clearBtn" class="btn secondary" type="button">清空本地保存</button>
        </div>
        <div id="notice" class="notice"></div>
        <div class="tips">
          第一版使用 IMAPS/TLS 直连，推荐端口 993。密码只会提交给当前 Worker 用于本次 IMAP 登录，Worker 不做服务端存储。
        </div>
      </section>

      <section class="panel">
        <div id="messages" class="messages">
          <div class="empty">填写 IMAP 信息后点击拉取。</div>
        </div>
      </section>
    </div>

    <div class="footer">Cloudflare Workers · IMAPS 993 · 本地浏览器保存</div>
  </div>

  <script>
    const STORAGE_ACCOUNT = 'cfmail_imap.account';
    const STORAGE_PASSWORD = 'cfmail_imap.password';

    const hostInput = document.getElementById('hostInput');
    const portInput = document.getElementById('portInput');
    const limitInput = document.getElementById('limitInput');
    const emailInput = document.getElementById('emailInput');
    const passwordInput = document.getElementById('passwordInput');
    const rememberInput = document.getElementById('rememberInput');
    const fetchBtn = document.getElementById('fetchBtn');
    const clearBtn = document.getElementById('clearBtn');
    const noticeEl = document.getElementById('notice');
    const messagesEl = document.getElementById('messages');

    function loadAccount() {
      const raw = localStorage.getItem(STORAGE_ACCOUNT);
      if (raw) {
        try {
          const account = JSON.parse(raw);
          hostInput.value = account.host || '';
          portInput.value = account.port || 993;
          emailInput.value = account.email || '';
          rememberInput.checked = true;
        } catch (error) {
          localStorage.removeItem(STORAGE_ACCOUNT);
        }
      }
      const password = localStorage.getItem(STORAGE_PASSWORD);
      if (password) {
        passwordInput.value = password;
        rememberInput.checked = true;
      }
    }

    function saveAccount() {
      if (!rememberInput.checked) {
        clearAccount(false);
        return;
      }
      const account = {
        host: hostInput.value.trim(),
        port: Number(portInput.value || 993),
        email: emailInput.value.trim()
      };
      localStorage.setItem(STORAGE_ACCOUNT, JSON.stringify(account));
      localStorage.setItem(STORAGE_PASSWORD, passwordInput.value);
    }

    function clearAccount(show = true) {
      localStorage.removeItem(STORAGE_ACCOUNT);
      localStorage.removeItem(STORAGE_PASSWORD);
      if (show) showNotice('已清空本地保存');
    }

    function setLoading(loading) {
      fetchBtn.disabled = loading;
      fetchBtn.textContent = loading ? '拉取中...' : '拉取最近邮件';
    }

    function showNotice(text, isError = false) {
      noticeEl.textContent = text;
      noticeEl.className = isError ? 'notice error' : 'notice';
    }

    function currentPayload() {
      return {
        host: hostInput.value.trim(),
        port: Number(portInput.value || 993),
        limit: Number(limitInput.value || 20),
        email: emailInput.value.trim(),
        password: passwordInput.value
      };
    }

    async function fetchMessages() {
      const payload = currentPayload();

      if (!payload.host || !payload.email || !payload.password) {
        showNotice('请填写 IMAP 地址、邮箱和密码', true);
        return;
      }

      setLoading(true);
      showNotice('正在连接 IMAP 服务器...');

      try {
        const response = await fetch('/api/fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.details || data.error || '拉取失败');
        }
        saveAccount();
        renderMessages(data.messages || []);
        showNotice('已拉取最近邮件');
      } catch (error) {
        showNotice(error.message || '拉取失败', true);
      } finally {
        setLoading(false);
      }
    }

    function renderMessages(messages) {
      if (!messages.length) {
        messagesEl.innerHTML = '<div class="empty">邮箱中没有可显示的邮件。</div>';
        return;
      }
      messagesEl.innerHTML = '';
      for (const message of messages) {
        const item = document.createElement('article');
        item.className = 'mail';
        item.dataset.uid = message.uid;
        item.dataset.loaded = 'false';
        const date = message.date ? new Date(message.date).toLocaleString() : '未知时间';
        item.innerHTML = [
          '<h3></h3>',
          '<div class="meta"><span></span><span></span></div>',
          '<div class="meta-line from"><strong>From:</strong> <span></span></div>',
          '<div class="meta-line to"><strong>To:</strong> <span></span></div>',
          '<div class="meta-line cc"><strong>Cc:</strong> <span></span></div>',
          '<div class="meta-line reply"><strong>Reply-To:</strong> <span></span></div>',
          '<div class="meta-line id"><strong>Message-ID:</strong> <span></span></div>',
          '<p class="preview"></p>',
          '<div class="body empty"></div>'
        ].join('');
        item.querySelector('h3').textContent = message.subject || '无主题';
        const spans = item.querySelectorAll('.meta span');
        spans[0].textContent = message.from || '未知发件人';
        spans[1].textContent = date;
        fillOptionalLine(item, '.from span', message.from);
        fillOptionalLine(item, '.to span', message.to);
        fillOptionalLine(item, '.cc span', message.cc);
        fillOptionalLine(item, '.reply span', message.replyTo);
        fillOptionalLine(item, '.id span', message.messageId);
        item.querySelector('.preview').textContent = message.hasPlainText
          ? (message.preview || '无正文预览')
          : '未找到 plain text 正文';
        item.querySelector('.body').textContent = '点击读取 plain text 正文';
        item.addEventListener('click', () => toggleMessageBody(item, message));
        messagesEl.appendChild(item);
      }
    }

    function fillOptionalLine(item, selector, value) {
      const span = item.querySelector(selector);
      const line = span.closest('.meta-line');
      if (!value) {
        line.style.display = 'none';
        return;
      }
      span.textContent = value;
    }

    async function toggleMessageBody(item, message) {
      const bodyEl = item.querySelector('.body');
      if (item.classList.contains('open')) {
        item.classList.remove('open');
        return;
      }
      item.classList.add('open');
      if (item.dataset.loaded === 'true') return;

      if (!message.hasPlainText) {
        bodyEl.className = 'body empty';
        bodyEl.textContent = '未找到 plain text 正文';
        item.dataset.loaded = 'true';
        return;
      }

      bodyEl.className = 'body loading';
      bodyEl.textContent = '正在读取正文...';

      try {
        const response = await fetch('/api/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...currentPayload(), uid: message.uid })
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.details || data.error || '读取正文失败');
        }
        bodyEl.className = data.body ? 'body' : 'body empty';
        bodyEl.textContent = data.body || data.message || '未找到 plain text 正文';
        if (data.truncated) {
          bodyEl.textContent += '\\n\\n[正文较长，当前只显示前 64KB]';
        }
        item.dataset.loaded = 'true';
      } catch (error) {
        bodyEl.className = 'body empty';
        bodyEl.textContent = error.message || '读取正文失败';
      }
    }

    fetchBtn.addEventListener('click', fetchMessages);
    clearBtn.addEventListener('click', () => {
      clearAccount(true);
      rememberInput.checked = false;
      passwordInput.value = '';
    });
    rememberInput.addEventListener('change', () => {
      if (!rememberInput.checked) clearAccount(false);
    });

    loadAccount();
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8'
    }
  });
}
