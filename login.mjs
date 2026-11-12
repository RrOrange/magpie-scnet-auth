// SCNet 账号密码登录 → 拿到 API Key → 写进 magpie 的 plugin-auth.json
//
//   node login.mjs                 交互输入用户名/密码
//   node login.mjs <用户名> <密码>  直接传参（脚本用）
//
// 不需要 SCNet 客户端，也不需要抓包。

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { execFileSync } from "node:child_process"
import { createInterface } from "node:readline"

const { _internal } = await import(new URL("./index.mjs", import.meta.url))
const { loginWithPassword } = _internal

function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg ? join(xdg, "magpie") : join(homedir(), ".config", "magpie")
}

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY })
    if (hidden && process.stdin.isTTY) {
      process.stdout.write(question)
      const stdin = process.stdin
      stdin.setRawMode?.(true)
      let buf = ""
      const onData = (c) => {
        const s = c.toString()
        if (s === "\r" || s === "\n") {
          stdin.setRawMode?.(false)
          stdin.removeListener("data", onData)
          process.stdout.write("\n")
          rl.close()
          resolve(buf)
        } else if (s === "\u0003") {
          process.exit(130)
        } else if (s === "\u007f") {
          buf = buf.slice(0, -1)
        } else {
          buf += s
        }
      }
      stdin.on("data", onData)
      return
    }
    rl.question(question, (a) => {
      rl.close()
      resolve(a)
    })
  })
}

// 找到本插件在 magpie 里真实的 provider id（scnet 或 scnet-plugin）
function providerId() {
  try {
    const out = execFileSync("magpie", ["plugin", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    const data = JSON.parse(out)
    const hit = (data.providers ?? []).find((p) => String(p.spec ?? "").includes("scnet-plugin"))
    if (hit?.id) return hit.id
  } catch {}
  return "scnet"
}

let [username, password] = process.argv.slice(2)
if (!username) username = (await ask("SCNet 用户名 / 手机号: ")).trim()
if (!password) password = await ask("密码: ", true)

if (!username || !password) {
  console.error("用户名和密码都要填。")
  process.exit(1)
}

console.log("正在登录 SCNet …")
let cred
try {
  cred = await loginWithPassword(username, password)
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
  copyFileSync(file, file + ".bak-scnet-login")
}

const id = providerId()
db[id] = {
  type: "api",
  key: cred.key,
  metadata: { username, baseUrl: cred.baseUrl, via: "password-login" },
}
writeFileSync(file, JSON.stringify(db, null, 2) + "\n", { mode: 0o600 })

console.log(`✓ 已写入 ${file}（provider: ${id}）`)
console.log("")
console.log("下一步：重启 magpie（或 magpie plugin off/on " + id + "），然后")
console.log("  magpie provider test " + id + " GLM-5.3-Flash")
