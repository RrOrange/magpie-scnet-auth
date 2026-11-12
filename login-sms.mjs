// SCNet 短信验证码登录 → 换 API Key → 写入 magpie
//
//   node login-sms.mjs              交互：输入手机号 → 收码 → 输入验证码
//   node login-sms.mjs <手机号>      只传手机号，验证码再交互输入
//
// 与账号密码登录等价，只是第一步用短信验证码。

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { execFileSync } from "node:child_process"
import { createInterface } from "node:readline"

const { _internal } = await import(new URL("./index.mjs", import.meta.url))
const { sendPhoneCode, loginWithPhoneCode } = _internal

function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg ? join(xdg, "magpie") : join(homedir(), ".config", "magpie")
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (a) => {
      rl.close()
      resolve(a)
    })
  })
}

function providerId() {
  try {
    const out = execFileSync("magpie", ["plugin", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    const data = JSON.parse(out)
    const hit = (data.providers ?? []).find((p) => String(p.spec ?? "").includes("scnet"))
    if (hit?.id) return hit.id
  } catch {}
  return "scnet"
}

let phone = (process.argv[2] || "").trim()
if (!phone) phone = (await ask("手机号: ")).trim()
if (!/^\d{6,15}$/.test(phone)) {
  console.error("手机号格式不对。")
  process.exit(1)
}

console.log(`正在发送验证码到 ${phone.slice(0, 3)}****${phone.slice(-4)} …`)
try {
  await sendPhoneCode(phone)
} catch (e) {
  console.error("发送失败：" + (e?.message || e))
  process.exit(1)
}
console.log("✓ 已发送，请查收短信。")

const code = (await ask("短信验证码: ")).trim()
if (!code) {
  console.error("验证码不能为空。")
  process.exit(1)
}

console.log("正在登录 …")
let cred
try {
  cred = await loginWithPhoneCode(phone, code)
} catch (e) {
  console.error("登录失败：" + (e?.message || e))
  process.exit(1)
}
console.log("✓ 登录成功，已取得 API Key：" + cred.key.slice(0, 6) + "…（长度 " + cred.key.length + "）")

const dir = configDir()
const file = join(dir, "plugin-auth.json")
if (!existsSync(dir)) {
  console.error(`找不到 magpie 配置目录 ${dir}，请先启动一次 magpie。`)
  process.exit(1)
}
let db = {}
if (existsSync(file)) {
  try {
    db = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    db = {}
  }
  copyFileSync(file, file + ".bak-scnet-sms")
}
const id = providerId()
db[id] = {
  type: "api",
  key: cred.key,
  metadata: { phoneNum: phone, baseUrl: cred.baseUrl, via: "sms-login" },
}
writeFileSync(file, JSON.stringify(db, null, 2) + "\n", { mode: 0o600 })
console.log(`✓ 已写入 ${file}（provider: ${id}）`)
console.log("")
console.log(`下一步：重启 magpie（或 magpie plugin off/on ${id}），然后`)
console.log(`  magpie provider test ${id} GLM-5.3-Flash`)
