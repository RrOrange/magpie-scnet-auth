// SCNet 计算互联网 → magpie provider 插件
//
// 事实依据（本机实测）：
//   - 平台是标准 OpenAI 兼容：POST https://api.scnet.cn/api/llm/v1/chat/completions
//     Authorization: Bearer <key>，流式带 choices[].delta.reasoning_content
//   - GET /api/llm/v1/models 用这把 key 能列出 32 个模型（GLM-5.3-Flash / Qwen3.8 / Kimi-K3 …）
//   - SCNet 客户端把凭据和模型元数据存在本机：
//       %USERPROFILE%\.sclaw\agent\scnet-credentials\*.json  → {scnet:{type:"api-key",key}}
//       %USERPROFILE%\.sclaw\agent\models.json              → providers.scnet.models[]（含 contextWindow 等）
//
// 所以插件不需要任何抓包或注入：登录时填 local，它自己去客户端目录里取 key。
// 插件同时内置一个本地过滤代理：SCNet 上游会拒绝 logit_bias/n，并在复杂 tool schema
// 下随机返回 code 10013；代理会剥离这些参数，并对 10013 逐级简化工具 schema 后重试。

import { readFileSync, readdirSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { request as httpsRequest } from "node:https"
import { homedir } from "node:os"
import { join } from "node:path"

const PROVIDER = "scnet"
const UPSTREAM_BASE = (process.env.SCNET_BASE || "https://api.scnet.cn/api/llm/v1").replace(/\/+$/, "")
const PROXY_PORT = Number(process.env.SCNET_PROXY_PORT || 3427)
const AGENT_DIR = process.env.SCNET_AGENT_DIR || join(homedir(), ".sclaw", "agent")
const CRED_DIR = join(AGENT_DIR, "scnet-credentials")
const MODELS_FILE = join(AGENT_DIR, "models.json")

// 兜底：客户端读不到时至少可用
const FALLBACK = { "GLM-5.3-Flash": { name: "GLM-5.3-Flash", context: 1000000, output: 131072, reasoning: true } }

// 平台给了 32 个模型，但额度是按模型隔离的：没额度的调用会 402 Insufficient Balance。
// 默认全部列出（账号不同，能用哪些只有自己知道）；想收窄用 SCNET_MODELS。
//   SCNET_MODELS=…                逗号分隔的模型 id
//   SCNET_MODELS=known            只列本机实测有额度的（GLM-5.3-Flash / SCNet-Max）
//   SCNET_PROBE=1                 逐个实测余额（max_tokens=1），只留有额度的
const KNOWN_IDS = ["GLM-5.3-Flash", "SCNet-Max"]

// ---------- 内置过滤代理 ----------
// SCNet rejects logit_bias/n and intermittently rejects complex tool schemas with
// code 10013 "Invalid request parameters". The proxy strips unsupported params,
// retries 10013 by progressively simplifying tool schemas, and falls back to no tools.
const DROP_PARAMS = ["logit_bias", "n"]
const MAX_ATTEMPTS = 4
let proxyState = null // { server, baseURL }

function isCode10013(buf) {
  try {
    const j = JSON.parse(buf.toString("utf8"))
    return String(j?.code || j?.error?.code || "") === "10013" ||
      /Invalid request parameters/i.test(String(j?.error?.message || j?.message || ""))
  } catch {
    return false
  }
}

function sanitizeSchema(node) {
  if (!node || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const child of node) sanitizeSchema(child)
    return
  }
  delete node.$schema
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (Array.isArray(node[key])) {
      const kept = node[key].filter((part) => !part || !part.pattern)
      if (kept.length) node[key] = kept
      else delete node[key]
    }
  }
  if (node.pattern && /\\[uU]|\^\[\^/.test(String(node.pattern))) delete node.pattern
  for (const value of Object.values(node)) sanitizeSchema(value)
}

function simplifyTools(j, level) {
  if (!Array.isArray(j.tools)) return false
  if (level === 1) {
    for (const t of j.tools) sanitizeSchema(t?.function?.parameters ?? t?.parameters)
    return true
  }
  if (level === 2) {
    for (const t of j.tools) {
      const p = t?.function?.parameters ?? t?.parameters
      if (!p) continue
      delete p.$schema; delete p.additionalProperties
      delete p.allOf; delete p.anyOf; delete p.oneOf
      const walk = (n) => {
        if (!n || typeof n !== "object") return
        if (Array.isArray(n)) return n.forEach(walk)
        delete n.pattern; delete n.minLength; delete n.maxLength
        delete n.minimum; delete n.maximum; delete n.multipleOf
        Object.values(n).forEach(walk)
      }
      walk(p)
    }
    return true
  }
  if (level === 3) {
    delete j.tools; delete j.tool_choice
    return true
  }
  return false
}

function forwardUpstream(upstream, method, path, headers, body) {
  return new Promise((resolve) => {
    const u = new URL(upstream)
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port || 443,
        servername: u.hostname,
        path: u.pathname.replace(/\/$/, "") + path,
        method,
        headers: { ...headers, host: u.host, "content-length": String(body.length) },
        timeout: 180000,
      },
      (up) => {
        const chunks = []
        up.on("data", (c) => chunks.push(c))
        up.on("end", () => resolve({ status: up.statusCode || 502, headers: up.headers, body: Buffer.concat(chunks) }))
        up.on("error", (e) => resolve({ status: 502, headers: {}, body: Buffer.from(JSON.stringify({ error: e.message })) }))
      },
    )
    req.on("timeout", () => req.destroy(new Error("upstream timeout")))
    req.on("error", (e) => resolve({ status: 502, headers: {}, body: Buffer.from(JSON.stringify({ error: e.message })) }))
    req.end(body)
  })
}

async function ensureProxy() {
  if (proxyState) return proxyState
  const upstream = UPSTREAM_BASE
  const server = createServer((req, res) => {
    const reqPath = req.url || "/"
    const reqMethod = req.method || "GET"
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", async () => {
      let body = Buffer.concat(chunks)
      let parsed = null
      if (body.length) try { parsed = JSON.parse(body.toString("utf8")) } catch {}
      if (parsed) {
        for (const k of DROP_PARAMS) delete parsed[k]
        body = Buffer.from(JSON.stringify(parsed), "utf8")
      }
      const headers = { ...req.headers }
      delete headers.connection
      delete headers["content-length"]
      delete headers.host
      let result
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        result = await forwardUpstream(upstream, reqMethod, reqPath, headers, body)
        if (result.status !== 400 || !isCode10013(result.body)) break
        if (!parsed || !simplifyTools(parsed, attempt + 1)) break
        body = Buffer.from(JSON.stringify(parsed), "utf8")
      }
      const outHeaders = { ...result.headers }
      delete outHeaders.connection
      delete outHeaders["transfer-encoding"]
      if (!outHeaders["content-type"]) outHeaders["content-type"] = "application/json"
      res.writeHead(result.status, outHeaders)
      res.end(result.body)
    })
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(PROXY_PORT, "127.0.0.1", resolve)
  })
  server.unref?.()
  proxyState = { server, baseURL: `http://127.0.0.1:${PROXY_PORT}` }
  return proxyState
}

async function proxyBaseURL() {
  try {
    const { baseURL } = await ensureProxy()
    return baseURL
  } catch {
    return UPSTREAM_BASE
  }
}

function selectedIds(allIds) {
  const spec = (process.env.SCNET_MODELS || "").trim().toLowerCase()
  if (!spec || spec === "all" || spec === "*") return allIds
  if (spec === "known" || spec === "mine") {
    const lower = new Set(KNOWN_IDS.map((x) => x.toLowerCase()))
    const picked = allIds.filter((id) => lower.has(id.toLowerCase()))
    return picked.length ? picked : KNOWN_IDS.filter((id) => allIds.some((a) => a.toLowerCase() === id.toLowerCase()))
  }
  const want = spec.split(",").map((x) => x.trim()).filter(Boolean)
  return allIds.filter((id) => want.includes(id.toLowerCase()))
}

// 可选：SCNET_PROBE=1 时实测每个模型是否还有余额（max_tokens=1，几乎不耗额度）
async function probeIds(key, ids) {
  const ok = []
  const queue = [...ids]
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift()
      try {
        const r = await fetch(`${UPSTREAM_BASE}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model: id, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false }),
          signal: AbortSignal.timeout(20000),
        })
        if (r.ok) ok.push(id)
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
  return ids.filter((id) => ok.includes(id))
}

let cachedKey = null
let cachedKeyAt = 0
let cachedCatalog = null
let cachedCatalogAt = 0

const enc = new TextEncoder()

// ---------- 账号密码登录（不用客户端、不用抓包） ----------
// 链路（来自 scnet-client 源码）：POST /ac/api/auth/loginDesktopClient.action
//   username + RSA(password) + encrypted=true + ph=1  →  Set-Cookie: Token=…
// 再用 cookie 调 POST /acx/llm/api-key/createActivityApiKey  →  {data:{apiKey:"sk-…", baseUrl:…}}
const WEB_ORIGIN = "https://www.scnet.cn"
const LOGIN_URL = `${WEB_ORIGIN}/ac/api/auth/loginDesktopClient.action`
const CAPTCHA_URL = `${WEB_ORIGIN}/ac/api/auth/isNeedCpatcha.action`
const ACTIVITY_KEY_URL = `${WEB_ORIGIN}/acx/llm/api-key/createActivityApiKey`
const SEND_CODE_URL = `${WEB_ORIGIN}/ac/api/auth/sendDesktopClientPhoneCode.action`
const LOGIN_CODE_URL = `${WEB_ORIGIN}/ac/api/auth/loginDesktopClientByPhoneCode.action`
const RSA_PUB = "MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBALaXEnbjI6fjy+t9W9AiO/KS0q+b/OZFS+7ykinLbiriUx9P8BcuuHnVbXNiZp5jW70eVGBtX4DhGUPzJa1YT/8CAwEAAQ=="
const UA = "scnet-client/4.1.2"

async function rsaEncrypt(plain) {
  const { publicEncrypt, constants } = await import("node:crypto")
  const pem = "-----BEGIN PUBLIC KEY-----\n" + RSA_PUB.match(/.{1,64}/g).join("\n") + "\n-----END PUBLIC KEY-----"
  return publicEncrypt({ key: pem, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(plain, "utf8")).toString("base64")
}

async function needCaptcha() {
  try {
    const r = await fetch(CAPTCHA_URL, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) })
    const j = await r.json()
    return j?.data === true
  } catch {
    return false
  }
}

function cookiesOf(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []
  const raw = list.length ? list : (res.headers.get("set-cookie") ?? "").split(/,(?=[^;,]+=)/)
  return raw.map((c) => String(c).split(";")[0].trim()).filter(Boolean).join("; ")
}

// ---------- 短信验证码登录 ----------
// 两步：POST sendDesktopClientPhoneCode {phoneNum} → Set-Cookie（服务端记住手机号）
//       POST loginDesktopClientByPhoneCode {messageCode} + 该 Cookie → 登录
let pendingSms = null

async function sendPhoneCode(phoneNum) {
  const phone = String(phoneNum || "").trim()
  if (!/^\d{6,15}$/.test(phone)) throw new Error("手机号格式不对")
  const r = await fetch(SEND_CODE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: new URLSearchParams({ phoneNum: phone }),
    signal: AbortSignal.timeout(20000),
  })
  const j = await r.json().catch(() => null)
  if (j?.type === "success" || j?.code === "0000" || j?.code === 0) {
    pendingSms = { phoneNum: phone, cookie: cookiesOf(r), at: Date.now() }
    return { ok: true }
  }
  throw new Error(j?.msg || j?.message || `发送失败 (${r.status})`)
}

async function loginWithPhoneCode(phoneNum, code) {
  const phone = String(phoneNum || "").trim()
  const messageCode = String(code || "").trim()
  if (!phone || !messageCode) throw new Error("手机号和验证码都要填")
  const c = pendingSms && pendingSms.phoneNum === phone && Date.now() - pendingSms.at < 10 * 60_000 ? pendingSms.cookie : ""
  const r = await fetch(LOGIN_CODE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA, ...(c ? { cookie: c } : {}) },
    body: new URLSearchParams({ messageCode }),
    signal: AbortSignal.timeout(20000),
  })
  const j = await r.json().catch(() => null)
  if (!(j?.type === "success" || j?.code === "0000" || j?.code === 0)) {
    throw new Error(j?.msg || j?.message || `登录失败 (${r.status})`)
  }
  const cookie = cookiesOf(r) || c
  if (!cookie) throw new Error("登录接口未返回 Cookie（Token）")
  return exchangePhoneCode(cookie)
}

async function exchangePhoneCode(cookie) {
  const r = await fetch(ACTIVITY_KEY_URL, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "user-agent": UA },
    body: "{}",
    signal: AbortSignal.timeout(20000),
  })
  const j = await r.json().catch(() => null)
  const key = j?.data?.apiKey
  if (!key) throw new Error(j?.msg || j?.message || "创建 API Key 失败")
  return { key, baseUrl: String(j?.data?.baseUrl || UPSTREAM_BASE).replace(/\/+$/, "") }
}

async function loginWithPassword(username, password) {
  const user = String(username || "").trim()
  const pass = String(password || "")
  if (!user || !pass) throw new Error("用户名和密码都要填")
  if (await needCaptcha()) throw new Error("账号需要验证码，请先在浏览器登录一次 scnet.cn 解除，或改用「发送短信验证码」。")

  const encryptedPwd = await rsaEncrypt(pass)
  const body = new URLSearchParams({ username: user, password: encryptedPwd, encrypted: "true", ph: "1" })
  const r = await fetch(LOGIN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body,
    signal: AbortSignal.timeout(20000),
  })
  const j = await r.json().catch(() => null)
  if (!(j?.type === "success" || j?.code === "0000" || j?.code === 0)) {
    throw new Error(j?.msg || j?.message || `登录失败 (${r.status})`)
  }
  const cookie = cookiesOf(r)
  if (!cookie) throw new Error("登录接口未返回 Cookie（Token）")
  return exchangePhoneCode(cookie)
}

// ---------- 凭据：读 SCNet 客户端本机目录 ----------
function keysFromClient() {
  let files
  try {
    files = readdirSync(CRED_DIR).filter((f) => f.endsWith(".json"))
  } catch {
    return []
  }
  const out = []
  for (const f of files) {
    const p = join(CRED_DIR, f)
    try {
      const st = statSync(p)
      if (!st.isFile()) continue
      const d = JSON.parse(readFileSync(p, "utf8"))
      const k = d?.scnet?.key
      if (typeof k === "string" && k.length > 10) out.push({ key: k, file: f, mtime: st.mtimeMs })
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

async function keyWorks(key) {
  try {
    const r = await fetch(`${UPSTREAM_BASE}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    })
    return r.ok
  } catch {
    return false
  }
}

async function clientKey() {
  if (cachedKey && Date.now() - cachedKeyAt < 300_000) return cachedKey
  const candidates = keysFromClient()
  for (const c of candidates) {
    if (await keyWorks(c.key)) {
      cachedKey = c.key
      cachedKeyAt = Date.now()
      return cachedKey
    }
  }
  if (candidates[0]) {
    cachedKey = candidates[0].key
    cachedKeyAt = Date.now()
    return cachedKey
  }
  throw new Error(
    `读不到 SCNet 凭据：${CRED_DIR} 为空或不存在。请先登录 SCNet 客户端（计算服务），或直接粘贴 API Key。`,
  )
}

// 登录凭据支持三种形态：
//   local                → 从本机 SCNet 客户端目录读 key
//   sk-xxx               → 直接把这个 key 用在 SCNet 平台
//   {"baseUrl":…,"apiKey":…,"models":[…]} → 接任意 OpenAI 兼容服务（分发/自建用）
async function resolveCred(raw) {
  const s = String(raw ?? "").trim()
  if (!s || /^(local|auto|本机|自动)$/i.test(s)) {
    return { baseUrl: UPSTREAM_BASE, apiKey: await clientKey(), models: null }
  }
  if (s.startsWith("{")) {
    let j
    try {
      j = JSON.parse(s)
    } catch {
      throw new Error('凭据 JSON 解析失败。形如 {"baseUrl":"https://…/v1","apiKey":"…","models":["m1","m2"]}')
    }
    const apiKey = j.apiKey || j.key
    if (!apiKey) throw new Error("凭据 JSON 缺少 apiKey")
    return {
      baseUrl: String(j.baseUrl || j.baseURL || UPSTREAM_BASE).replace(/\/+$/, ""),
      apiKey,
      models: Array.isArray(j.models) && j.models.length ? j.models : null,
    }
  }
  return { baseUrl: UPSTREAM_BASE, apiKey: s, models: null }
}

// ---------- 模型目录：客户端元数据 + 平台 /models 交叉 ----------

function clientCatalog() {
  if (cachedCatalog && Date.now() - cachedCatalogAt < 300_000) return cachedCatalog
  try {
    const d = JSON.parse(readFileSync(MODELS_FILE, "utf8"))
    const list = d?.providers?.scnet?.models
    if (Array.isArray(list)) {
      const map = {}
      for (const m of list) {
        if (!m?.id) continue
        map[m.id] = {
          name: m.name || m.id,
          context: m.contextWindow,
          output: m.maxTokens,
          reasoning: !!m.reasoning,
          tool_call: m.toolCalling !== false,
          input: Array.isArray(m.input) ? m.input : ["text"],
        }
      }
      cachedCatalog = map
      cachedCatalogAt = Date.now()
      return map
    }
  } catch {}
  return {}
}

async function platformModels(baseUrl, key) {
  const r = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) })
  if (!r.ok) throw new Error(`/models 返回 ${r.status}`)
  const d = await r.json()
  return (d?.data ?? []).map((m) => m.id).filter(Boolean)
}

function toModel(id, meta) {
  const m = meta?.[id] ?? {}
  return {
    name: m.name || id,
    limit: { context: m.context ?? 131072, output: m.output ?? 32768 },
    reasoning: m.reasoning ?? false,
    tool_call: m.tool_call ?? true,
    modalities: { input: m.input ?? ["text"] },
  }
}

// ---------- 插件 ----------

export const SCNetAuthPlugin = async ({ client }) => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: "SCNet 计算互联网",
      npm: "@ai-sdk/openai-compatible",
      api: UPSTREAM_BASE,
      models: Object.fromEntries(
        Object.entries(FALLBACK).map(([id, m]) => [
          id,
          { name: m.name, limit: { context: m.context, output: m.output }, reasoning: m.reasoning, tool_call: true },
        ]),
      ),
    }
  },

  auth: {
    provider: PROVIDER,
    methods: [
      {
        type: "api",
        label: "SCNet 账号密码登录",
        prompts: [
          { type: "text", key: "username", message: "SCNet 用户名 / 手机号", placeholder: "手机号或用户名" },
          { type: "password", key: "password", message: "密码" },
        ],
        async authorize(inputs) {
          try {
            const out = await loginWithPassword(String(inputs?.username ?? "").trim(), String(inputs?.password ?? ""))
            return { type: "success", key: out.key, metadata: { username: inputs.username, baseUrl: out.baseUrl } }
          } catch (e) {
            return { type: "failed", error: String(e?.message || e).slice(0, 500) }
          }
        },
      },
      {
        type: "api",
        label: "① 发送短信验证码",
        prompts: [{ type: "text", key: "phoneNum", message: "手机号（接收验证码）" }],
        async authorize(inputs) {
          try {
            await sendPhoneCode(inputs?.phoneNum)
            return { type: "failed", error: "验证码已发送。请再选「② 短信验证码登录」，填入手机号和收到的 6 位验证码。" }
          } catch (e) {
            return { type: "failed", error: String(e?.message || e).slice(0, 500) }
          }
        },
      },
      {
        type: "api",
        label: "② 短信验证码登录",
        prompts: [
          { type: "text", key: "phoneNum", message: "手机号" },
          { type: "text", key: "messageCode", message: "短信验证码" },
        ],
        async authorize(inputs) {
          try {
            const out = await loginWithPhoneCode(inputs?.phoneNum, inputs?.messageCode)
            return { type: "success", key: out.key, metadata: { phoneNum: String(inputs?.phoneNum || ""), baseUrl: out.baseUrl } }
          } catch (e) {
            return { type: "failed", error: String(e?.message || e).slice(0, 500) }
          }
        },
      },
      {
        type: "api",
        label: "API Key（local = 读本机客户端；或粘贴 sk-… / JSON）",
        placeholder: "local",
      },
    ],

    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api") return {}
      const cred = await resolveCred(auth.key)
      // 强制走本地过滤代理；自定义 baseUrl 仅用于 models 发现，不直连发给上游。
      return { baseURL: await proxyBaseURL(), apiKey: cred.apiKey }
    },
  },

  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      let cred
      try {
        cred = await resolveCred(auth?.key)
      } catch {
        return provider.models
      }
      const meta = clientCatalog()
      // 自定义服务：凭据里直接给了模型列表，不用再问
      if (cred.models) {
        const out = {}
        for (const id of cred.models) out[id] = toModel(id, meta)
        return out
      }
      try {
        let ids = await platformModels(cred.baseUrl, cred.apiKey)
        if (!ids.length) return provider.models
        ids = selectedIds(ids)
        if (process.env.SCNET_PROBE === "1") ids = await probeIds(cred.apiKey, ids)
        const out = {}
        for (const id of ids) out[id] = toModel(id, meta)
        return out
      } catch {
        // 平台拉不到就退到客户端目录
        const ids = selectedIds(Object.keys(meta))
        if (!ids.length) return provider.models
        const out = {}
        for (const id of ids) out[id] = toModel(id, meta)
        return out
      }
    },
  },
})

export const _internal = { PROVIDER, UPSTREAM_BASE, PROXY_PORT, ensureProxy, proxyBaseURL, keysFromClient, clientKey, clientCatalog, toModel, loginWithPassword, rsaEncrypt, sendPhoneCode, loginWithPhoneCode, exchangePhoneCode }
