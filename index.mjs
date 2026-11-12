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

import { readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const PROVIDER = "scnet"
const BASE = process.env.SCNET_BASE || "https://api.scnet.cn/api/llm/v1"
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
        const r = await fetch(`${BASE}/chat/completions`, {
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

async function loginWithPassword(username, password) {
  if (await needCaptcha()) {
    throw new Error("该账号当前需要图形验证码。请先用 API Key 登录，或在 scnet.cn 网页登录一次后再试。")
  }
  const body = new URLSearchParams({
    username,
    password: await rsaEncrypt(password),
    captcha: "",
    captchaKey: "",
    encrypted: "true",
    ph: "1",
  })
  const r = await fetch(LOGIN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body,
    signal: AbortSignal.timeout(20000),
  })
  const j = await r.json()
  if (String(j?.code) !== "0") throw new Error(`SCNet 登录失败：${j?.msg || j?.code || r.status}`)
  const cookie = cookiesOf(r)
  if (!cookie) throw new Error("SCNet 登录成功但没有拿到会话 cookie")

  const r2 = await fetch(ACTIVITY_KEY_URL, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, "user-agent": UA },
    body: "{}",
    signal: AbortSignal.timeout(20000),
  })
  const j2 = await r2.json()
  const key = j2?.data?.apiKey
  if (!key) throw new Error(`取 API Key 失败：${j2?.msg || j2?.code || r2.status}（账号可能未开通模型服务）`)
  return { key, baseUrl: j2.data.baseUrl, model: j2.data.model }
}

// ---------- 凭据：优先客户端目录，其次显式 key ----------

function keysFromClient() {
  const out = []
  try {
    for (const f of readdirSync(CRED_DIR)) {
      if (!f.endsWith(".json")) continue
      const p = join(CRED_DIR, f)
      try {
        const d = JSON.parse(readFileSync(p, "utf8"))
        const k = d?.scnet?.key
        if (typeof k === "string" && k.length > 10) out.push({ key: k, file: f, mtime: statSync(p).mtimeMs })
      } catch {}
    }
  } catch {}
  return out.sort((a, b) => b.mtime - a.mtime)
}

async function keyWorks(key) {
  try {
    const r = await fetch(`${BASE}/models`, {
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
    return { baseUrl: BASE, apiKey: await clientKey(), models: null }
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
      baseUrl: String(j.baseUrl || j.baseURL || BASE).replace(/\/+$/, ""),
      apiKey,
      models: Array.isArray(j.models) && j.models.length ? j.models : null,
    }
  }
  return { baseUrl: BASE, apiKey: s, models: null }
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
      api: BASE,
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
        label: "API Key（local = 读本机客户端；或粘贴 sk-… / JSON）",
        placeholder: "local",
      },
    ],

    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api") return {}
      const cred = await resolveCred(auth.key)
      const metaBase = typeof auth.metadata?.baseUrl === "string" ? auth.metadata.baseUrl.replace(/\/+$/, "") : ""
      return { baseURL: metaBase || cred.baseUrl, apiKey: cred.apiKey }
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

export const _internal = { PROVIDER, BASE, keysFromClient, clientKey, clientCatalog, toModel, loginWithPassword, rsaEncrypt }
