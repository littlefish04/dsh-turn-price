/**
 * dsh-turn-cost — 每轮 token 用量的**容错折叠**（宿主侧，纯函数，可单测）
 *
 * ── 为什么不用 DSH 自带的 `deriveTurnTokenUsage` ────────────────────────────────
 * 它要求「有 totalTokens，或 cacheRead + cacheWrite 都有」，否则整轮 `undefined`。
 * 实测（2026-10-05，本机真实日志）有 15/77 个回合因此**连金额都显示不出来** ——
 * 共同形状是 `{inputTokens, outputTokens, cacheReadTokens}`（`zai/glm-5.3-flash`
 * 与 `deepseek-vision/deepseek-v4-flash` 都是这样）。被手动停止的回合同样整轮作废。
 *
 * 本模块按用户拍板的口径改成**容错求和**：缺的缓存桶记 0、缺 usage 的步骤跳过，
 * 于是所有模型、被停止的回合都能出数。
 *
 * ── 与官方 `tokenUsage` 投影必须逐项相等 ──────────────────────────────────────
 * 本折叠刻意与 `@deepseek-ai/dsh-token-meter` 的 `tokenUsage` 投影
 * （`lib/types/usage-projection.js`）保持**同一套加法与替换语义**，因为
 * `tools/test-session-fold.mjs` 会拿官方那份定义逐回合对拍：
 *
 *   · 只处理 `assistant/message` 与 `assistant/attempt`；
 *   · `assistant/message` 优先用 `data.usage`，没有才回退到 `data.stream` 里最后
 *     一个 usage 块；`assistant/attempt` **只看 stream**（照 `usageOf()`）；
 *   · 桶 = `{inputTokens, outputTokens, cacheReadTokens ?? 0, cacheWriteTokens ?? 0}`，
 *     `totalTokens` / `reasoningTokens` **不参与**；
 *   · 同 `(turn, step)` 的后续样本**替换**前一个（`totals - previous + next`），
 *     桶完全相同则不动；
 *   · `llm/retry-started` 命中当前 `(turn, step)` 时清掉「上一个样本」槽位 →
 *     重试后的新样本**累加**（两次尝试都算钱）。
 *
 * ── 与官方投影的唯一有意差异 ─────────────────────────────────────────────────
 * 官方投影把 `init.totals` 累加**全部**事件（含 `turn/start` 之前的），本模块
 * `state.totals` 只累加 `assistant/*` 样本 —— 但样本只可能出现在轮内，所以两者
 * 相等。`tools/test-session-fold.mjs` 用官方定义在**同一份事件**上对拍来钉死这一点。
 *
 * ── 增量使用方式 ─────────────────────────────────────────────────────────────
 * `createSessionUsage()` 建一个持有者，`applyEvent(state, event)` 就地推进并返回
 * 同一个 state（纯函数语义、调用方独占引用）；`foldEvents(state, events)` 用于
 * 回填整份日志。宿主用 `ctx.on('session/event', …)` 喂增量，用
 * `ctx.sessionQuery.readSession()` 做首次回填。
 */

/** 4 个桶，与 `dsh-token-meter` 的 `projectionSchema` 同形。 */
export function zeroBuckets() {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

/** `TokenUsage` → 4 个桶（缺缓存桶记 0）。`totalTokens` / `reasoningTokens` 不参与。 */
export function bucketsFrom(usage) {
  return {
    uncachedInputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  }
}

export function bucketsEqual(left, right) {
  return left.uncachedInputTokens === right.uncachedInputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
}

/** `totals - previous + next`（照官方 `addReplacing`）。 */
export function addReplacing(totals, previous, next) {
  return {
    uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + next.uncachedInputTokens,
    outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
    cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
  }
}

export function addBuckets(totals, buckets) {
  return addReplacing(totals, undefined, buckets)
}

/**
 * 一个事件的用量样本（**照官方 `usageOf()` 写，别猜字段**）。
 * @returns {object|undefined} `TokenUsage`，或 undefined 表示该事件不带样本
 */
export function usageOf(event) {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  return lastUsageChunk(event.data.stream)
}

/** `stream` 里**最后一个** usage 块（照官方 `lastAssistantStreamChunk`）。 */
export function lastUsageChunk(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record && record.type === 'chunk' && record.chunk && record.chunk.type === 'usage') return record.chunk.usage
  }
  return undefined
}

/** `assistant/message` 的路由（`message.source`）；provider/model 缺一即 undefined。 */
export function routeOf(event) {
  const source = event.type === 'assistant/message' && event.data.message ? event.data.message.source : undefined
  if (!source) return undefined
  if (typeof source.provider !== 'string' || source.provider === '') return undefined
  if (typeof source.model !== 'string' || source.model === '') return undefined
  return { provider: source.provider, model: source.model }
}

function pushRoute(routes, route) {
  if (route === undefined) return
  for (const existing of routes) if (existing.provider === route.provider && existing.model === route.model) return
  routes.push(route)
}

/** 新建一份会话折叠状态。 */
export function createSessionUsage() {
  return {
    /** 当前进行中的回合号；undefined 表示不在轮内。 */
    turn: undefined,
    /** 当前进行中的步骤号。 */
    step: undefined,
    /** 上一个样本槽位：`{turn, step, buckets}`，用于同 (turn,step) 的替换语义。 */
    last: null,
    /** 全会话 4 桶合计 —— **必须等于官方 tokenUsage 投影的 totals**。 */
    totals: zeroBuckets(),
    /** 轮号 → 聚合结果（含进行中的那一轮）。 */
    turns: new Map(),
    /** 已折到的最大 seq。 */
    seenThroughSeq: -1,
  }
}

function ensureTurn(state, turn) {
  let entry = state.turns.get(turn)
  if (entry === undefined) {
    entry = {
      turn,
      endSeq: null,
      endTime: null,
      reason: null,
      interrupted: false,
      routes: [],
      buckets: null,
      samples: 0,
    }
    state.turns.set(turn, entry)
  }
  return entry
}

/**
 * 推进一个持久事件。
 *
 * ⚠️ 就地修改 `state` 并返回它（调用方独占引用）。这样增量路径每轮都是 O(1)，
 * 不必整份复制 `turns`。
 * @returns {object} 同一个 state
 */
export function applyEvent(state, event) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return state
  const seq = typeof event.seq === 'number' ? event.seq : null
  if (seq !== null && seq > state.seenThroughSeq) state.seenThroughSeq = seq

  switch (event.type) {
    case 'turn/start': {
      state.turn = event.data.turn
      state.step = undefined
      state.last = null
      ensureTurn(state, event.data.turn)
      return state
    }
    case 'llm/retry-started': {
      /* 官方语义：命中当前 (turn, step) 时关掉「替换槽位」→ 重试后的新样本累加。 */
      if (state.last !== null && state.last.turn === event.data.turn && state.last.step === event.data.step) {
        state.last = null
      }
      return state
    }
    case 'step/end': {
      state.last = null
      state.step = undefined
      return state
    }
    case 'turn/end': {
      const entry = ensureTurn(state, event.data.turn)
      entry.endSeq = seq
      entry.endTime = typeof event.time === 'number' ? event.time : null
      entry.reason = event.data.reason ? event.data.reason.kind : null
      state.turn = undefined
      state.step = undefined
      state.last = null
      return state
    }
    default:
      break
  }

  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state

  /* `step/start` 也带 turn/step，但样本事件自己就带，所以直接用事件上的坐标。 */
  const turn = event.data.turn
  const step = event.data.step
  if (typeof turn !== 'number' || typeof step !== 'number') return state

  const sample = usageOf(event)
  if (sample === undefined) {
    /* 中断的那半截消息没有 usage：跳过，**不让整轮作废**。 */
    if (event.type === 'assistant/message' && event.data.interrupted === true) {
      ensureTurn(state, turn).interrupted = true
    }
    return state
  }

  const buckets = bucketsFrom(sample)
  const previous = state.last !== null && state.last.turn === turn && state.last.step === step
    ? state.last.buckets
    : undefined

  const entry = ensureTurn(state, turn)
  pushRoute(entry.routes, routeOf(event))

  if (previous !== undefined && bucketsEqual(previous, buckets)) {
    /* 桶完全相同 → 官方投影原地不动；这里也只补状态，不加钱。 */
    state.turn = turn
    state.step = step
    return state
  }

  const next = addReplacing(state.totals, previous, buckets)
  state.totals = next
  entry.buckets = entry.buckets === null ? buckets : addReplacing(entry.buckets, previous, buckets)
  entry.samples += 1
  state.last = { turn, step, buckets }
  state.turn = turn
  state.step = step
  return state
}

/** 回填：把一串事件按 seq 升序喂进去。 */
export function foldEvents(state, events) {
  if (!Array.isArray(events)) return state
  for (const event of events) applyEvent(state, event)
  return state
}

/** 新建并从整份事件折一次。 */
export function foldAll(events) {
  return foldEvents(createSessionUsage(), events)
}

/**
 * 导出可交给客户端计价的每轮数据（按 `endSeq` 升序）。
 *
 * `buckets === null` 表示该轮**一个样本都没有** → 客户端不显示金额（不是 0）。
 */
export function turnsOf(state) {
  const out = []
  for (const entry of state.turns.values()) {
    out.push({
      turn: entry.turn,
      endSeq: entry.endSeq,
      endTime: entry.endTime,
      reason: entry.reason,
      interrupted: entry.interrupted,
      routes: entry.routes.slice(),
      /**
       * 计价用的路由 = 路由列表的**最后一个**。
       *
       * ⚠️ 语义说明（实测核对过）：官方 `deriveTurnTokenUsage` 用 `Map` 去重，
       * 重复 `set` 同一 key **不改变它在 Map 中的位置** → 它的 `routes` 是
       * **首次出现顺序**，所以「最后一个」= **最后一个不同的路由**，
       * 不一定是"最后一次尝试"。既有插件（`util/` 之前的客户端实现）就是这么
       * 取 route 的，多路由断言（`test-pricing` 的「多路由取末次尝试」）与它一致，
       * 所以这里保持同一读法。真正的「末次尝试」需要 `llm/retry-started` 级别的
       * 事件顺序，不在这份投影里 —— 见报告里标注的文档措辞偏差。
       */
      route: entry.routes.length ? entry.routes[entry.routes.length - 1] : null,
      buckets: entry.buckets === null ? null : { ...entry.buckets },
      samples: entry.samples,
    })
  }
  out.sort((left, right) => {
    if (left.endSeq === null && right.endSeq === null) return left.turn - right.turn
    if (left.endSeq === null) return 1
    if (right.endSeq === null) return -1
    return left.endSeq - right.endSeq
  })
  return out
}

/** 已有 `endSeq` 的轮数（回填完整度的粗略指标）。 */
export function sealedTurnCount(state) {
  let count = 0
  for (const entry of state.turns.values()) if (entry.endSeq !== null) count += 1
  return count
}
