/**
 * dsh-turn-cost — 会话总计里的**子会话**部分（IMPLEMENTATION-PROMPT §6.3 / §9）
 *
 * 用户拍板的口径：**父会话逐轮精确 + 子会话按 `tokenUsage` 投影 × 单价**。
 * 子会话那半边天生是近似（投影只给会话级 4 桶合计，没有逐轮时刻），所以
 * **必须在明细里标注按哪个模型计价**（§9 明确要求）。
 *
 * 约束（照 §6.3 的上限，防一次请求把宿主拖死）：
 *   · 深度 ≤ 5、会话数 ≤ 200、总超时 3s；
 *   · 任一上限被触到 → `truncated: true`，UI 标「部分」；
 *   · **单个子会话读取失败不能影响父会话数字**（逐条隔离，失败的记进 `errors`）。
 */

export const MAX_DEPTH = 5
export const MAX_SESSIONS = 200
export const TOTAL_TIMEOUT_MS = 3000

/** 后代列表项里的诊断分支（branches 读不到时会出现在结果里）。 */
function isDiagnostic(entry) {
  return entry !== null && typeof entry === 'object' && entry.kind === 'diagnostic'
}

/**
 * 取一个会话的 `tokenUsage` 投影（会话级 4 桶）。
 * @returns `{buckets}|{reason}` —— 失败不抛，交给调用方隔离
 */
async function readTokenUsage(sessionQuery, sessionId, timeoutMs) {
  try {
    const observation = await withTimeout(
      sessionQuery.observeSession(sessionId, { projectionMode: 'all' }),
      timeoutMs,
    )
    try {
      const values = observation && observation.projections && observation.projections.values
      const official = values ? values.tokenUsage : undefined
      if (official === undefined) return { reason: 'no-projection' }
      return {
        buckets: {
          uncachedInputTokens: Number(official.uncachedInputTokens) || 0,
          outputTokens: Number(official.outputTokens) || 0,
          cacheReadTokens: Number(official.cacheReadTokens) || 0,
          cacheWriteTokens: Number(official.cacheWriteTokens) || 0,
        },
      }
    } finally {
      if (observation && typeof observation.dispose === 'function') observation.dispose()
    }
  } catch (err) {
    return { reason: err && err.name === 'TimeoutError' ? 'timeout' : 'read-failed', detail: err && err.message ? err.message : String(err) }
  }
}

function withTimeout(promise, ms) {
  if (!(ms > 0)) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error('子会话读取超时')
      err.name = 'TimeoutError'
      reject(err)
    }, ms)
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

/**
 * 取一个会话**最后一条 assistant 消息**的路由（子会话按它计价）。
 * 读完整日志比较贵，所以优先用 `readSession`；失败就退化成"没有路由"。
 * @returns `{route, title}|null`
 */
async function readRouteAndTitle(sessionQuery, sessionId, timeoutMs) {
  try {
    const snapshot = await withTimeout(sessionQuery.readSession(sessionId), timeoutMs)
    const events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : []
    let route = null
    let title = ''
    for (const event of events) {
      if (event.type === 'assistant/message') {
        const source = event.data && event.data.message ? event.data.message.source : null
        if (source && typeof source.provider === 'string' && source.provider !== ''
          && typeof source.model === 'string' && source.model !== '') {
          route = { provider: source.provider, model: source.model }
        }
      }
      /* 标题事件：数组/字符串两种形态都兼容。 */
      if (event.type === 'session/title') {
        const data = event.data || {}
        if (typeof data.title === 'string' && data.title !== '') title = data.title
      }
    }
    return { route, title }
  } catch (err) {
    return { route: null, title: '', reason: err && err.name === 'TimeoutError' ? 'timeout' : 'read-failed' }
  }
}

/**
 * 枚举并汇总一个根会话的后代。
 *
 * @param deps `{subagents, sessionQuery, now}`
 * @param rootSessionId
 * @param options `{maxDepth, maxSessions, timeoutMs}`
 * @returns `{items, truncated, errors, reason?}`
 *          `items` = `[{sessionId, label, depth, buckets, route, title}]`
 */
export async function collectChildUsage(deps, rootSessionId, options = {}) {
  const maxDepth = Math.max(1, Math.min(10, Number(options.maxDepth ?? MAX_DEPTH)))
  const maxSessions = Math.max(1, Math.min(1000, Number(options.maxSessions ?? MAX_SESSIONS)))
  const timeoutMs = Math.max(200, Math.min(30000, Number(options.timeoutMs ?? TOTAL_TIMEOUT_MS)))
  const deadline = (typeof deps.now === 'function' ? deps.now() : Date.now()) + timeoutMs

  const subagents = deps.subagents
  const sessionQuery = deps.sessionQuery
  if (!subagents || typeof subagents.listDescendants !== 'function') {
    return { items: [], truncated: false, errors: [], reason: 'no-subagents' }
  }
  if (!sessionQuery || typeof sessionQuery.observeSession !== 'function') {
    return { items: [], truncated: false, errors: [], reason: 'no-session-query' }
  }

  let entries
  try {
    entries = await withTimeout(subagents.listDescendants(rootSessionId), timeoutMs)
  } catch (err) {
    return {
      items: [],
      truncated: false,
      errors: [{ reason: err && err.name === 'TimeoutError' ? 'timeout' : 'list-failed', detail: err && err.message ? err.message : String(err) }],
    }
  }

  const items = []
  const errors = []
  let truncated = false
  const seen = new Set()

  for (const entry of Array.isArray(entries) ? entries : []) {
    /* ⚠️ 列表里**可能有 null / undefined / 非对象**（实测：一个 null 条目会让
       `entry.id` 抛 TypeError，而那会把整个 /usage.json 打成 500 —— 连父会话的数字
       都拿不到）。这里逐个挡掉，绝不让单个坏条目牵连整体。 */
    if (entry === null || typeof entry !== 'object') {
      errors.push({ reason: 'bad-entry' })
      continue
    }
    if (isDiagnostic(entry)) {
      errors.push({ sessionId: String(entry.id || ''), reason: String(entry.reason || 'diagnostic') })
      continue
    }
    const sessionId = typeof entry.id === 'string' ? entry.id : ''
    if (sessionId === '' || sessionId === rootSessionId || seen.has(sessionId)) continue
    seen.add(sessionId)
    const depth = Number(entry.depth)
    if (Number.isFinite(depth) && depth > maxDepth) { truncated = true; continue }
    if (items.length >= maxSessions) { truncated = true; break }
    if ((typeof deps.now === 'function' ? deps.now() : Date.now()) >= deadline) {
      truncated = true
      errors.push({ reason: 'deadline' })
      break
    }

    /* 单个子会话失败只影响它自己（§6.3：不能影响父会话数字）。 */
    const remaining = Math.max(200, deadline - (typeof deps.now === 'function' ? deps.now() : Date.now()))
    const usage = await readTokenUsage(sessionQuery, sessionId, Math.min(remaining, timeoutMs))
    if (usage.reason !== undefined) {
      errors.push({ sessionId, reason: usage.reason })
      continue
    }
    const extra = await readRouteAndTitle(sessionQuery, sessionId, Math.min(remaining, timeoutMs))
    if (extra.reason !== undefined) {
      /* 路由读不到不算失败：桶是对的，只是不知道该按哪个模型计价 →
         客户端会把它标成「未计价」而不是猜一个模型。 */
      errors.push({ sessionId, reason: 'route-' + extra.reason })
    }
    items.push({
      sessionId,
      label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : '',
      mode: entry.mode === undefined ? 'unknown' : entry.mode,
      depth: Number.isFinite(depth) ? depth : 1,
      buckets: usage.buckets,
      route: extra.route,
      title: extra.title || '',
    })
  }

  return { items, truncated, errors }
}

/**
 * 把子会话汇总折成客户端好用的形状。
 *
 * `unpricedReasons` 单独统计「读到了桶但没法计价」的原因 —— 这类**不是读取错误**
 * （`errors` 只放真正的失败），但 UI 必须能说明白为什么某个子代理显示 `—`：
 *   · `no-route` —— 拿不到最后一次 assistant 消息的模型（明细里标「不知道模型」）
 *   · `no-usage` —— 连用量桶都没有
 */
export function summarizeChildren(collected) {
  const items = Array.isArray(collected && collected.items) ? collected.items : []
  let priced = 0
  let noRoute = 0
  let noUsage = 0
  for (const item of items) {
    if (!item.buckets) noUsage += 1
    else if (!item.route) noRoute += 1
    else priced += 1
  }
  const unpricedReasons = []
  if (noRoute > 0) unpricedReasons.push('no-route')
  if (noUsage > 0) unpricedReasons.push('no-usage')
  return {
    count: items.length,
    priced,
    unpriced: noRoute + noUsage,
    unpricedReasons,
    noRoute,
    noUsage,
    truncated: collected && collected.truncated === true,
    errors: Array.isArray(collected && collected.errors) ? collected.errors : [],
  }
}
