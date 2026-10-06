/**
 * dsh-turn-cost — 宿主侧的 JSON-over-HTTP 小工具（IMPLEMENTATION-PROMPT §4.1）
 *
 * 只做三件事，避免每个路由重复写：读 query、写 JSON、统一失败语义。
 * 客户端约定：所有响应都是 JSON 且带 `ok`；失败绝不显示成 0。
 */

/**
 * 一个路由的全部端点都挂在同一个 prefix 下。
 *
 * ⚠️ **`prefix` 路线的 `path` 绝不能带尾斜杠。** 实测 DSH 的 `webServer.match()`
 * （`@deepseek-ai/dsh-host-webserver`）用的是：
 *     if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
 * 所以 `path: '/dsh-turn-price/'`（带尾斜杠）只能匹配
 *     pathname === '/dsh-turn-price/'            或
 *     pathname.startsWith('/dsh-turn-price//')   ← 双斜杠，永远不会有
 * —— 于是 `/dsh-turn-price/usage.json` **一次都不会命中**，全部 404。
 * 这个 bug 在 2026-10-05 的真实重启里暴露过（路由"注册成功"但从未被调用）。
 * 另外 `handler` 拿到的 `req.url` 是**完整路径**（不会被剥掉 prefix），
 * 所以 `lib/index.js` 里比较的是 `ROUTE_PREFIX + '/xxx.json'`。
 */
export const ROUTE_PREFIX = '/dsh-turn-price'
export const ROUTE_PATH = ROUTE_PREFIX

/**
 * 复刻 DSH `webServer.match()` 的 prefix 判定，供离线测试断言"我们注册的 path
 * 真的能匹配到我们要用的 URL"。改了 `ROUTE_PATH` 就会被这条测试拦住。
 */
export function prefixMatches(prefix, pathname) {
  return pathname === prefix || pathname.startsWith(prefix + '/')
}

/** 取 URL 的 pathname（req.url 可能带 query）。 */
export function pathnameOf(req) {
  const url = req && typeof req.url === 'string' ? req.url : ''
  const cut = url.indexOf('?')
  return cut < 0 ? url : url.slice(0, cut)
}

/** 取 query 参数（容错：非法 URL 不抛）。 */
export function queryOf(req, name) {
  const url = req && typeof req.url === 'string' ? req.url : ''
  const cut = url.indexOf('?')
  if (cut < 0) return null
  try {
    return new URLSearchParams(url.slice(cut + 1)).get(name)
  } catch (err) {
    return null
  }
}

/** 写一个 JSON 响应。`res` 是 Node 的 ServerResponse。 */
export function sendJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload)
    res.statusCode = status
    if (typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
    }
    res.end(body)
  } catch (err) {
    /* 响应已经发出/连接断了：静默，交给宿主日志。 */
  }
}

export function sendOk(res, payload) {
  sendJson(res, 200, { ok: true, ...payload })
}

/**
 * 统一失败语义：`{ok:false, reason}`。
 *
 * `reason` 用稳定性字符串（`warming` / `no-session` / `not-found` / `internal`），
 * 只有 `detail` 才是给人看的细节 —— 客户端按 reason 决定文案，不解析 detail。
 */
export function sendFail(res, reason, status, detail) {
  sendJson(res, status === undefined ? 200 : status, {
    ok: false,
    reason,
    ...detail === undefined ? {} : { detail: String(detail) },
  })
}

/**
 * 读请求体（POST 用）。上限 256KB，超了直接截断 —— 这些端点只收小 JSON。
 * @returns {Promise<object|null>}
 */
export async function readJsonBody(req, limitBytes = 262144) {
  if (!req || typeof req.on !== 'function') return null
  return await new Promise((resolve) => {
    let size = 0
    const chunks = []
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        finish(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return finish({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        finish(parsed && typeof parsed === 'object' ? parsed : null)
      } catch (err) {
        finish(null)
      }
    })
    req.on('error', () => finish(null))
    req.on('aborted', () => finish(null))
  })
}
