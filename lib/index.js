/**
 * dsh-turn-cost — Host 半体
 *
 * 本文件只做一件事：**声明插件自己的 Cordis Config**。
 *
 * DSH 0.2 的设置模型：插件设置 = 插件自己的 Cordis Config。框架
 * （@deepseek-ai/dsh-settings）在 Loader 加载完成后扫描每个 active 条目，把它的
 * Config schema 投影成表单；表单以 **profile 条目 id**（cordis.patch.yml 里那条
 * insert 的 `id:`，本插件为 `turn-cost`）作为命名空间，客户端用
 * `ctx.configForms.get('turn-cost')` 取到同形的 ConfigForm。
 * 写入经 config-editor 落盘到 <DSH_HOME>/profiles/<profile>/cordis.patch.yml。
 *
 * 关键前提（踩过的坑，见 dsh-plugin-notify-sound 的注释）：
 *   dsh-settings 的 describe() 只把**含 volatile 字段**的条目投影成表单：
 *       const form = volatileForm(schema)
 *       if (form === void 0) return []      // 没有 volatile 字段 → 整个条目被丢弃
 *   所以 Config 必须声明 volatile（这里用根级 `.volatile()`，一个 volatile 节点
 *   覆盖全部字段），否则：
 *     - configForms 快照永远是 status:'unavailable'；
 *     - 设置页里看不到本插件；
 *     - 任何写入都会被 `Plugin entry "turn-cost" has no volatile fields` 拒绝。
 *
 * 价格表因此就是一个普通 Config 字段（models 数组），由框架负责校验、落盘、
 * 跨窗口同步与版本控制（revision），客户端只读写这一个字段。
 *
 * 价格口径与官方 DeepSeek 文档一致：
 *   - 单价单位 = 「每百万 tokens」的金额，货币见 currency（默认人民币 ¥）。
 *   - 基础价 = **空闲时段价**（官方：空闲时段价 = 高峰时段价的一半）。
 *   - 高峰时段用 rules 表达：北京时间周一至周五 09:00–12:00、14:00–18:00，系数 ×2。
 *   - promos 是绝对时间区间的限时特价，优先级最高。
 */
import z from '@deepseek-ai/schemastery'
import * as nodeFs from 'node:fs'
import { createSessionUsage, foldEvents, turnsOf, sealedTurnCount } from './session-usage.js'
import { collectChildUsage, summarizeChildren } from './child-usage.js'
import {
  ESTIMATE_SCOPE,
  aggregateDaySummary,
  aggregateMonthSummary,
  aggregateRangeSummary,
  dayOf,
  ledgerPathOf,
  partsOfScope,
  pruneLedger,
  reconcileBalance,
  recordTurn,
  scopesOf,
  turnsAcrossBooks,
} from './ledger.js'
import { balanceView, createBalanceManager, describeCredential, resolveCredentialValue, testConnection } from './balance-runtime.js'
import { adapterCredentialRefs, adapterOf } from './balance.js'
import { ROUTE_PATH, ROUTE_PREFIX, pathnameOf, queryOf, readJsonBody, sendFail, sendJson, sendOk } from './http.js'

export const name = 'turn-cost'

/**
 * 宿主半体不声明任何 inject。
 *
 * ⚠️ **不要往这里加 `'config'`**（2026-10-05 实测：同一个 404 的第三层陷阱）：
 * Cordis 的 `inject` 数组里必须是**注册进服务表的服务名**。`config` 不是服务 —— 它是
 * `Fiber` 身上的一个普通属性（`fiber.config`，由 `_resolveConfig()` 解析后赋值）。
 * 把 `'config'` 声明进 inject，`Fiber._refresh()` 会因为「有注入项在服务表里找不到」
 * 把整个 fiber 置为 INACTIVE，条目卡在 `pending`，`apply()` 依旧永不执行 ——
 * 症状和原来的「路由全 404」一模一样，是第三次误诊陷阱。
 *
 * 正确读法见 `readConfig()`：走 `ctx.fiber.config`（普通属性，不经过服务的注入门禁），
 * 并保留 `ctx.config` 作为兜底分支。
 *
 * 同理**不要**把客户端依赖（如 `@deepseek-ai/dsh-client-ui-settings`）写进来：
 * 宿主侧没有那个服务，同样会把条目卡成 pending。inject 里写服务名，不是包名。
 */
export const inject = []

/**
 * DeepSeek 官方价格（人民币 / 百万 tokens，取**空闲时段**价作为基础价）。
 * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *
 * Model               缓存命中  缓存未命中  输出
 * deepseek-flash        0.02        1        4
 * deepseek-v4-pro       0.15       4.5      13.5
 *
 * DeepSeek 不对缓存写入单独计费，因此 cacheWrite 为 0。
 */
const DEEPSEEK_PEAK_RULES = [
  { label: '高峰', days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00', multiplier: 2 },
  { label: '高峰', days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00', multiplier: 2 },
]

/** 一份价格：四个 token 类别各自的单价（每 perTokens 个 token 的金额）。 */
const priceFields = () => ({
  input: z.number().default(0),
  cacheRead: z.number().default(0),
  cacheWrite: z.number().default(0),
  output: z.number().default(0),
})

/** 峰谷规则：一周内的循环时段（按 tzOffset 指定的时区判定），价格 × multiplier。 */
const ruleSchema = () =>
  z.object({
    label: z.string().default('高峰'),
    /** 0=周日 … 6=周六（与 Date#getUTCDay 一致）。 */
    days: z.array(z.number()).default([1, 2, 3, 4, 5]),
    /** "HH:mm"，按 tzOffset 时区。end < start 表示跨零点。 */
    start: z.string().default('09:00'),
    end: z.string().default('12:00'),
    multiplier: z.number().default(2),
  })

/**
 * 限时特价的两个端点字段。
 *
 * ⚠️ **必须容忍 YAML 的 Date**（2026-10-05 事故根因，不要再退回 `z.string()`）：
 * `cordis.patch.yml` 是 YAML，**未加引号**的 `from: 2026-10-01` 会被 js-yaml 按
 * YAML 1.1 时间戳隐式解析成 **Date 对象**，而不是字符串。而 Cordis 在调用 `apply()`
 * **之前**就会用插件导出的 `Config` 解析这条 config —— 校验一失败，fiber 直接变成
 * `failed`，`apply()` **一次都不会执行**，HTTP 路由自然全 404，而且日志里几乎没有痕迹
 * （只有启动期的 stderr 警告 + plugin_manager 里的 `fiberPhase: "failed"`）。
 * 症状极具误导性：模块 import 成功、模块体跑完、`apply` 明明是函数，就是不被调用。
 *
 * 这里接受 `string | Date`，并在校验通过后**归一成墙上时间字符串**
 * （`YYYY-MM-DDTHH:mm`，本机时区），与价格引擎 `parseWall()` 的口径一致：
 * 用户写 `2026-10-01`（未加引号）或 `'2026-10-01'`（加了引号）都得到相同结果。
 */
/**
 * 把 YAML 解析出来的日期归一成**墙上时间**字符串（`YYYY-MM-DDTHH:mm`）。
 *
 * 实测的 js-yaml 隐式类型规则（tools/yaml-date-probe.mjs，别凭记忆改）：
 *   `2026-10-01`            → **Date**，时刻是 **UTC 零点**（日期型 literal 无时区 → 按 UTC）
 *   `2026-10-01T00:00`      → **string**（YAML 1.1 的 timestamp 正则要求带秒，所以不匹配）
 *   `2026-10-01T00:00:00`   → **Date**（带秒 → 匹配）
 *   `2026-10-01T23:59:00Z`  → **Date**
 *
 * 因此：
 *   · **恰好落在日界（时分秒都=0）的 Date，一律按 UTC 日历日 + 本地 0 点**输出。
 *     这样 `2026-10-01` 在 UTC+8 得到 `2026-10-01T00:00`（用户的原意），
 *     而不是天真地用本地 getter 得到的 `08:00`（东八区会晚 8 小时，特价窗口整体偏移）；
 *     在 UTC-5 也不会退成 `2026-09-30`（那是"减一天"的另一种错）。
 *   · 其余情况用本地 getter：显式时区的绝对时刻（`…Z` / `+08:00`）由此得到**本地墙上时间**，
 *     正合本插件「按本地墙上时间判定峰谷/特价」的既有口径。
 */
function yamlDateText(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const pad = (n) => String(n).padStart(2, '0')
    const dayBoundary = value.getUTCHours() === 0 && value.getUTCMinutes() === 0
      && value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0
    const y = dayBoundary ? value.getUTCFullYear() : value.getFullYear()
    const mo = dayBoundary ? value.getUTCMonth() : value.getMonth()
    const d = dayBoundary ? value.getUTCDate() : value.getDate()
    const h = dayBoundary ? 0 : value.getHours()
    const mi = dayBoundary ? 0 : value.getMinutes()
    return y + '-' + pad(mo + 1) + '-' + pad(d) + 'T' + pad(h) + ':' + pad(mi)
  }
  return value
}

/** 墙上时间字段：接受字符串（`""` = 该端不设限）或 YAML 解析出来的 Date。 */
const wallTimeField = () => z.transform(z.union([z.string(), z.date()]), yamlDateText, true)

/**
 * 限时特价：绝对时间区间（按 tzOffset 时区的本地墙上时间），优先级最高。
 * multiplier 与四个覆盖价都可选：覆盖价用 -1 表示「不覆盖，沿用基础价」。
 */
const promoSchema = () =>
  z.object({
    label: z.string().default('限时优惠'),
    /** "YYYY-MM-DDTHH:mm"，空串表示该端不设限。 */
    from: wallTimeField().default(''),
    to: wallTimeField().default(''),
    multiplier: z.number().default(1),
    input: z.number().default(-1),
    cacheRead: z.number().default(-1),
    cacheWrite: z.number().default(-1),
    output: z.number().default(-1),
  })

/** 一个模型（路由）的价格条目。 */
const modelSchema = () =>
  z.object({
    /** 模型 id，与 token 用量里的 route.model 对应（如 deepseek-flash）。 */
    model: z.string().required(),
    /** 可选：provider id，留空表示不限 provider（同名模型只写一条即可）。 */
    provider: z.string().default(''),
    /** 可选：设置页里显示的名字，留空则用 model。 */
    label: z.string().default(''),
    ...priceFields(),
    rules: z.array(ruleSchema()).default([]),
    promos: z.array(promoSchema()).default([]),
  })

/**
 * 一个余额来源（IMPLEMENTATION-PROMPT §10.1）。
 *
 * ⚠️ **API key 不进这里** —— 密钥用 `ctx.credentials`（官方凭据库）存，
 * 这里只放**凭据名**（如 `DEEPSEEK_API_KEY`），设置页永远不回显密钥。
 */
const balanceSourceSchema = () =>
  z.object({
    id: z.string().default(''),
    label: z.string().default(''),
    /**
     * 适配器：deepseek / openrouter / moonshot-cn / moonshot-ai / stepfun / novita /
     * zhipu / zai / kimi-coding / minimax / openai-compatible / none。
     * `none` = 该 provider 没有余额接口（方舟、OpenAI、Anthropic…），只探活。
     */
    adapter: z.string().default('none'),
    /** 用当前会话的路由 provider 匹配哪些来源；留空表示匹配任意会话。 */
    providerIds: z.array(z.string()).default([]),
    /** 凭据名（`ctx.credentials.resolve(ref)` 的 ref），如 DEEPSEEK_API_KEY。 */
    credentialRef: z.string().default(''),
    /** 可选：覆盖适配器默认端点（自建中转用）。 */
    baseUrl: z.string().default(''),
    enabled: z.boolean().default(false),
  })

/** 汇总行 5 段的标识（顺序也由 displayOrder 表达）。 */
const DISPLAY_KEYS = ['balance', 'month', 'todayReal', 'todayEstimate', 'sessionTotal']

const displayItemsSchema = () =>
  z.object({
    balance: z.boolean().default(true),
    month: z.boolean().default(true),
    todayReal: z.boolean().default(true),
    todayEstimate: z.boolean().default(true),
    sessionTotal: z.boolean().default(true),
  })

/**
 * 插件配置。
 *
 * 全部字段都在根级 volatile 之下，因此 models 数组里的任意路径都可写
 * （dsh-settings 只接受 volatile 节点之下的写入路径）。
 */
export const Config = z
  .object({
    /** 总开关：关闭后不渲染任何每轮金额。 */
    enabled: z.boolean().default(true),
    /** 货币符号（仅用于显示）。 */
    currency: z.string().default('¥'),
    /** 单价的分母，默认每百万 tokens（与官方口径一致）。 */
    perTokens: z.number().default(1000000),
    /** 明细金额显示的小数位数。 */
    decimals: z.number().default(4),
    /** 判定峰谷/优惠时段用的时区偏移（小时），默认 +8 北京时间。 */
    tzOffset: z.number().default(8),
    /**
     * 未在价格表里找到模型时的行为：
     *   hide — 不显示金额（默认，避免误导）
     *   fallback — 用下面的兜底价计算
     */
    unknownModel: z.string().default('hide'),
    /** 兜底价。 */
    fallback: z.object(priceFields()).default({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }),
    /** 价格表：每个模型一条。 */
    models: z.array(modelSchema()).default([
      {
        model: 'deepseek-flash',
        provider: '',
        label: 'DeepSeek Flash',
        input: 1,
        cacheRead: 0.02,
        cacheWrite: 0,
        output: 4,
        rules: DEEPSEEK_PEAK_RULES,
        promos: [],
      },
      {
        model: 'deepseek-v4-pro',
        provider: '',
        label: 'DeepSeek V4 Pro',
        input: 4.5,
        cacheRead: 0.15,
        cacheWrite: 0,
        output: 13.5,
        rules: DEEPSEEK_PEAK_RULES,
        promos: [],
      },
    ]),

    /* ── 汇总行新增配置（IMPLEMENTATION-PROMPT §11）─────────────────────────
       注意：只有「用户可调参数」进 Config；日账/余额缓存等**运行数据**进
       `<DSH_HOME>/dsh-turn-price/ledger.json`，不要写进 cordis.patch.yml。 */

    /** 余额来源列表；密钥本身不进 Config（走 ctx.credentials）。 */
    balanceSources: z.array(balanceSourceSchema()).default([]),
    /** 余额自动刷新间隔（秒），60–3600。 */
    balanceRefreshSeconds: z.number().min(60).max(3600).default(300),
    /** 单次取余额的超时（毫秒），1000–30000。 */
    balanceTimeoutMs: z.number().min(1000).max(30000).default(8000),
    /** 日账保留时长（月），**1–24**，默认 12。 */
    ledgerRetentionMonths: z.number().min(1).max(24).default(12),
    /** 每月起始日，1–31（按当月天数自动钳制，如 31 在 2 月按 28/29）。 */
    monthStartDay: z.number().min(1).max(31).default(1),
    /** 汇总行 5 段各自的显示开关。 */
    displayItems: displayItemsSchema().default({
      balance: true,
      month: true,
      todayReal: true,
      todayEstimate: true,
      sessionTotal: true,
    }),
    /** 汇总行顺序（默认就是 §7.2 的文案顺序）。 */
    displayOrder: z.array(z.string()).default(DISPLAY_KEYS.slice()),
    /** 汇总行金额的小数位，0–4（明细仍用 decimals）。 */
    summaryDecimals: z.number().min(0).max(4).default(2),
    /** 悬停是否显示「更新于 x 分钟前」。 */
    showUpdatedAt: z.boolean().default(true),
    /** 估算徽标文案。 */
    estimateBadgeText: z.string().default('估算'),
    /** 数据不完整徽标文案。 */
    incompleteBadgeText: z.string().default('数据不完整'),
  })
  .volatile()

/* ────────────────────── 会话用量缓存与 HTTP 路由 ────────────────────── */

/**
 * 每个会话一份折叠缓存。
 *
 * 两条路径：
 *   · **增量（主）**：`ctx.on('session/event', …)` 每来一个持久事件就推进一格；
 *   · **回填**：某会话第一次被请求时，用 `ctx.sessionQuery.readSession(id)` 读全量日志折一次。
 *
 * `complete` 表示缓存确实覆盖了日志开头：只有回填成功、或增量事件严格连续
 * （`seq === seenThroughSeq + 1`）才为 true。不完整时 `/usage.json` 会给出
 * `complete:false`，客户端据此把该会话标记为「部分」。
 */
function createUsageCache() {
  return new Map()
}

/**
 * 记一轮的估算用量（`turn/end` 语义）。
 *
 * ⚠️ 两条路径都要走到：**增量**（`session/event` 里正好是 `turn/end`）与
 * **回填**（`readSession` 折完整日志）。只在增量路径记的话，"第一次打开某个
 * 会话"时的历史轮次全都不会入账 —— 实测确认过这个坑。
 *
 * 按 `sessionId:endSeq` 幂等，所以两条路径都调用也不会重复。
 */
function recordTurnEstimate(deps, ctx, config, sessionId, turn, fallbackTime) {
  if (!turn || turn.buckets === null || !turn.route) return false
  try {
    recordTurn(deps.balance.getLedger(), {
      sessionId,
      endSeq: turn.endSeq,
      endTime: turn.endTime === null || turn.endTime === undefined ? fallbackTime : turn.endTime,
      provider: turn.route.provider,
      model: turn.route.model,
      inputTokens: turn.buckets.uncachedInputTokens,
      outputTokens: turn.buckets.outputTokens,
      cacheReadTokens: turn.buckets.cacheReadTokens,
      cacheWriteTokens: turn.buckets.cacheWriteTokens,
    }, {
      tzOffset: Number(config.tzOffset ?? 8),
      /**
       * ⚠️ **写进固定的一本**（`ESTIMATE_SCOPE`），不要写 `ledger.active`。
       *
       * 旧实现写 `ledger.active`，而 `active` 每次余额观测都会换成另一本 ——
       * 于是同一轮会被写进不止一本账（增量写 A 本、启动回填时 active 已变成 B 本），
       * 读取端只看一本时就会**丢轮次**（2026-10-06 实测）。
       * 读取端统一走 `turnsAcrossBooks`（跨本 + 按 `k` 去重），历史数据同样能读出来。
       */
      scope: ESTIMATE_SCOPE,
    })
    deps.balance.markDirty()
    return true
  } catch (err) {
    if (typeof ctx.logger?.warn === 'function') {
      ctx.logger.warn('turn-cost: 估算入账失败 %s', err && err.message ? err.message : String(err))
    }
    return false
  }
}

function cacheEntry(cache, sessionId) {
  let entry = cache.get(sessionId)
  if (entry === undefined) {
    entry = { state: createSessionUsage(), complete: false, source: 'none', error: null }
    cache.set(sessionId, entry)
  }
  return entry
}

/** 用整份日志回填一个会话（幂等：重新回填得到同样的结果）。 */
function refillSession(deps, ctx, config, cache, sessionId, events) {
  const entry = cacheEntry(cache, sessionId)
  entry.state = createSessionUsage()
  foldEvents(entry.state, events)
  entry.complete = true
  entry.source = 'readSession'
  entry.error = null
  /* 回填出来的历史轮次也要入估算账（否则"第一次打开会话"时历史全都不入账）。 */
  for (const turn of turnsOf(entry.state)) {
    recordTurnEstimate(deps, ctx, config, sessionId, turn, turn.endTime)
  }
  deps.balance.flush()
  return entry
}

/**
 * 折叠自查（IMPLEMENTATION-PROMPT §6.2 / §14.3 必须做的那条）：
 * 我的折叠加出来的**会话 4 桶合计**必须与官方 `tokenUsage` 投影逐项相等。
 *
 * 官方投影是 `dsh-token-meter` 注册的投影单元，用
 * `observeSession(id, {projectionMode:'all'}).projections.values.tokenUsage` 读。
 * 这里把两组数字都回给客户端，不一致就摆明差异（而不是假装没事）。
 */
async function reconcileSession(sessionQuery, sessionId, mine) {
  try {
    const observation = await sessionQuery.observeSession(sessionId, { projectionMode: 'all' })
    try {
      const projections = observation && observation.projections
      const values = projections && projections.values ? projections.values : {}
      const official = values.tokenUsage
      if (official === undefined) {
        return { ok: false, reason: 'no-projection', detail: 'tokenUsage 投影不可用（token-meter 未注册？）' }
      }
      const same = official.uncachedInputTokens === mine.uncachedInputTokens
        && official.outputTokens === mine.outputTokens
        && official.cacheReadTokens === mine.cacheReadTokens
        && official.cacheWriteTokens === mine.cacheWriteTokens
      return {
        ok: same,
        reason: same ? 'match' : 'mismatch',
        official,
        mine,
        asOfSeq: projections.asOfSeq,
      }
    } finally {
      if (observation && typeof observation.dispose === 'function') observation.dispose()
    }
  } catch (err) {
    return { ok: false, reason: 'reconcile-failed', detail: err && err.message ? err.message : String(err) }
  }
}

/** 组装一个会话的用量响应。 */
async function usagePayload(ctx, deps, sessionId) {
  const cache = deps.cache
  const sessionQuery = safeGet(ctx, 'sessionQuery')
  if (!sessionQuery || typeof sessionQuery.readSession !== 'function') {
    return { ok: false, reason: 'warming', detail: 'sessionQuery 服务不可用' }
  }

  const entry = cacheEntry(cache, sessionId)
  if (!entry.complete) {
    try {
      const snapshot = await sessionQuery.readSession(sessionId)
      refillSession(deps, ctx, readConfig(ctx), cache, sessionId, snapshot && Array.isArray(snapshot.events) ? snapshot.events : [])
    } catch (err) {
      /* 读不到日志：如果是增量已经折了一部分，就把那部分给出去并标注不完整；
         一个事件都没有则如实报告 not-found。 */
      entry.error = err && err.message ? err.message : String(err)
      if (entry.state.turns.size === 0) {
        return { ok: false, reason: 'not-found', detail: entry.error }
      }
    }
  }

  const turns = turnsOf(entry.state)
  const reconcile = await reconcileSession(sessionQuery, sessionId, entry.state.totals)

  /* 子会话（§6.3）：父会话逐轮精确 + 子会话按 tokenUsage 投影 × 单价。
     上限深度 5 / 会话 200 / 总超时 3s；单个失败只影响它自己。
     ⚠️ 再包一层 try/catch 兜底：子代理那半边**绝不能**把父会话的数字一起打没
     （列表里一个 null 条目就曾让整个 /usage.json 变 500）。 */
  let children = { items: [], truncated: false, errors: [] }
  try {
    children = await collectChildUsage({
      subagents: safeGet(ctx, 'subagents'),
      sessionQuery,
      now: () => Date.now(),
    }, sessionId)
  } catch (err) {
    children = {
      items: [],
      truncated: false,
      errors: [{ reason: 'collect-failed', detail: err && err.message ? err.message : String(err) }],
    }
  }
  const childSummary = summarizeChildren(children)

  return {
    ok: true,
    sessionId,
    complete: entry.complete,
    source: entry.source,
    error: entry.error,
    seenThroughSeq: entry.state.seenThroughSeq,
    sealedTurns: sealedTurnCount(entry.state),
    turnCount: turns.length,
    sessionTotals: entry.state.totals,
    turns,
    reconcile,
    /* 子会话部分：`items` 逐条给出桶 + 路由（客户端用同一价格引擎计价）。
       注意 `collectChildUsage` 在"服务缺失/列表失败"时只返回 `reason`，没有 `items`
       —— 客户端会把它当空数组处理，但这里显式给一个空数组更稳。 */
    children: Array.isArray(children.items) ? children.items : [],
    childrenSummary: childSummary,
    childrenReason: children.reason,
    /* 该会话**最后一次**出现的 provider —— 客户端把它当 `providerHint` 回传给
       `/state.json`，用于匹配余额来源。
       为什么必须由客户端回传：宿主侧的会话折叠缓存只覆盖「插件启动之后」的事件，
       而用户当前这个会话往往在插件启动前就存在了 → `deps.cache` 里没有它
       → provider 为空 → 余额永远显示 —（2026-10-05 实测）。
       `turns` 里已经带了每轮的 route，客户端顺手就能取到，不必额外探测。 */
    provider: lastProviderOf(turns),
  }
}

/** 取一组轮次里**最后一个**有路由的 provider（与 §6.1「按最后一个样本的路由」一致）。 */
function lastProviderOf(turns) {
  if (!Array.isArray(turns)) return ''
  for (let i = turns.length - 1; i >= 0; i--) {
    const route = turns[i] && turns[i].route
    if (route && route.provider) return String(route.provider)
  }
  return ''
}

/**
 * 给聚合结果里的分来源明细补上人类可读的名字。
 *
 * 名字来源优先级：本次会话真实取数结果里的 `sourceLabel`（用户在设置页填的显示名，
 * 或适配器/回退路径给的名字）→ 适配器表里的 label → scope 的第一段（adapter 名）。
 *
 * ⚠️ 账本里**不存**这些名字：它是运行数据，改了适配器表或用户改了显示名之后
 * 旧名字就过期了。所以每次装配响应时现算，绝不写回账本。
 */
function labelForScope(scope, deps) {
  const parts = partsOfScope(scope)
  const cached = typeof deps.balance.lastResult === 'function' ? deps.balance.lastResult(scope) : null
  if (cached && cached.sourceLabel) return String(cached.sourceLabel)
  const adapter = adapterOf(parts.adapter)
  if (adapter && adapter.label) return String(adapter.label)
  return parts.adapter || String(scope || '')
}

/** 就地给 `sources[]` / `duplicates[]` 补 label（只作用于本次响应的新对象）。 */
function decorateSources(node, deps) {
  if (!node || typeof node !== 'object') return node
  for (const key of ['sources', 'duplicates']) {
    if (!Array.isArray(node[key])) continue
    for (const item of node[key]) {
      if (item && typeof item === 'object') item.label = labelForScope(item.scope, deps)
    }
  }
  return node
}

/** 逐天条目里的 `sources[]` 同样要补名字（日历的当日明细要用）。 */
function decorateDays(days, deps) {
  if (!Array.isArray(days)) return days
  for (const day of days) decorateSources(day, deps)
  return days
}

/**
 * 组装 `/daily.json` 的响应 —— 设置页「消费记录」日历图的数据源。
 *
 * 参数 `month` = `YYYY-MM`（不传则用记账月，即 `monthStartDay` 划出的那个区间）。
 *
 * 返回**逐天**事实 + **逐轮**估算原料：
 *   · `days[]`  —— `aggregateRangeSummary` 的结果（**多来源求和**后的金额、缺数据、
 *                  观测中、待核对、分来源明细、校正入口）
 *   · `turns[]` —— 该区间全部估算轮次（`{k,t,p,m,i,o,cr,cw,day,scope}`，**跨本去重**），
 *                  客户端用**同一价格引擎逐轮计价**（峰谷按各自时刻，不能先合并桶）
 *
 * ⚠️ **金额一律走聚合口径**（2026-10-06 用户报的 bug）：旧实现读 `ledger.active`
 * 那一本账，等于"哪个来源最后被取数就只算哪个来源"。
 *
 * ⚠️ **只能读到账本里已有的日子**：按用户拍板的「实时增量、不扫全库回填」，
 * 插件开始观测之前的日子没有余额观测 → 那些格子如实显示「无观测」。
 * 这不是缺陷，是数据边界；UI 必须把它和「消费 0 元」区分开（决策 #7）。
 */
function dailyPayload(deps, config, monthParam) {
  const tzOffset = Number(config.tzOffset ?? 8)
  const now = deps.now()
  const ledger = deps.balance.getLedger()
  const today = dayOf(now, tzOffset)

  /* 解析 `YYYY-MM`；给了就用自然月，没给就用记账月。 */
  let from
  let to
  let monthLabel = ''
  const requested = String(monthParam || '')
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(requested)) {
    monthLabel = requested
    from = requested + '-01'
    /* 该月最后一天：下个月 1 号往前退一天。用 UTC 日期算术，避开本地时区夏令时。 */
    const year = Number(requested.slice(0, 4))
    const monthIndex = Number(requested.slice(5, 7))
    const firstOfNext = new Date(Date.UTC(monthIndex === 12 ? year + 1 : year, monthIndex === 12 ? 0 : monthIndex, 1))
    firstOfNext.setUTCDate(firstOfNext.getUTCDate() - 1)
    to = firstOfNext.toISOString().slice(0, 10)
  } else {
    const summary = aggregateMonthSummary(ledger, { tzOffset, now, monthStartDay: config.monthStartDay })
    from = summary.from
    to = summary.to
    monthLabel = from.slice(0, 7)
  }

  const history = aggregateRangeSummary(ledger, { tzOffset, now, from, to })
  decorateDays(history.days, deps)
  decorateSources(history, deps)
  const turns = turnsAcrossBooks(ledger, { tzOffset, from, to })
  const prune = pruneLedger(ledger, {
    tzOffset,
    now,
    ledgerRetentionMonths: config.ledgerRetentionMonths,
    monthStartDay: config.monthStartDay,
  })

  return {
    ok: true,
    now,
    today,
    month: monthLabel,
    from,
    to,
    scope: history.scope,
    currency: history.currency,
    mixedCurrency: history.mixedCurrency,
    byCurrency: history.byCurrency,
    amount: history.amount,
    amountUnits: history.amountUnits,
    observedDays: history.observedDays,
    missingDays: history.missingDays,
    incompleteDays: history.incompleteDays,
    needsReviewDays: history.needsReviewDays,
    unobservedScopes: history.unobservedScopes,
    sources: history.sources,
    hasGap: history.hasGap,
    hasAnyObservation: history.hasAnyObservation,
    days: history.days,
    turns,
    /* 保留期：日历要能告诉用户「这一天已被裁剪」而不是「没观测」。 */
    retentionMonths: prune.retentionMonths,
    keepFrom: prune.keepFrom,
    nextPruneDay: prune.nextPruneDay,
  }
}

/**
 * 组装 `/state.json` 的响应。
 *
 * 客户端拿它渲染汇总行的「余额 / 本月 / 今日（真实）」三段与明细面板。
 * **金额计算仍在客户端**（唯一的计价实现）——这里给的是事实：观测值、轮次、区间。
 */
function statePayload(ctx, deps, config, sessionId, providerHint) {
  const tzOffset = Number(config.tzOffset ?? 8)
  const now = deps.now()
  const ledger = deps.balance.getLedger()
  const today = dayOf(now, tzOffset)

  /* 当前会话的路由 → 匹配余额来源（照 §10.1）。
     优先级：会话折叠缓存 → 客户端回传的 providerHint → 本进程见过的最后一个 provider。
     ⚠️ 中间那一环是必需的（2026-10-05 实测）：宿主缓存只覆盖插件启动**之后**的事件，
     而当前会话常常在插件启动前就存在，于是缓存里查不到 → provider 为空 → 余额恒为 —。 */
  let provider = ''
  const sessionEntry = sessionId ? deps.cache.get(sessionId) : undefined
  if (sessionEntry) provider = lastProviderOf(turnsOf(sessionEntry.state))
  if (provider === '') provider = String(providerHint || '')
  if (provider === '' && deps.lastProvider !== '') provider = deps.lastProvider
  if (provider !== '') deps.lastProvider = provider

  const resolved = deps.balance.resolveForProvider(config, provider)

  /* 记账区间：本月（按 monthStartDay）+ 今天。
     ⚠️ **必须用聚合口径**（2026-10-06 用户报的 bug）：旧实现读 `ledger.active` 那一本账，
     而 `active` 只是"最后一次取数的那本" —— 加了第二个余额来源之后，
     今日真实花费变成"最后那个来源的余额差值"（用户加 GLM 后恒为 0），
     DeepSeek 那本账里记着的当天消费完全看不见。见 ledger.js 的「跨本聚合」一节。 */
  const month = aggregateMonthSummary(ledger, {
    tzOffset,
    now,
    monthStartDay: config.monthStartDay,
  })
  const todayReal = aggregateDaySummary(ledger, today, { tzOffset, now })
  /* 历史日账（给明细面板用；区间 = 记账月，别把整本账塞给浏览器）。
     ⚠️ 这里**不带逐天的 `sources[]`**：分来源明细已由 `todayReal.sources` 与区间级
     `month.sources` 给出，逐天再带一份会让响应凭空翻倍（实测 31 天 × 3 本账 ≈ +28KB）。
     日历的当日详情走 `/daily.json`，那一份是带 sources 的。 */
  const history = aggregateRangeSummary(ledger, {
    tzOffset,
    now,
    from: month.from,
    to: month.to,
    includeSources: false,
  })
  decorateSources(month, deps)
  decorateSources(todayReal, deps)
  decorateSources(history, deps)
  decorateDays(history.days, deps)

  /* 今天/本月的估算轮次（客户端按各自时刻逐轮计价 —— 峰谷价按时刻变化，
     不能先把桶合并再算）。**跨本去重**：同一轮可能被写进过不止一本账。 */
  const todayTurns = turnsAcrossBooks(ledger, { tzOffset, from: today, to: today })
  const monthTurns = turnsAcrossBooks(ledger, { tzOffset, from: month.from, to: month.to })

  const prune = pruneLedger(ledger, {
    tzOffset,
    now,
    ledgerRetentionMonths: config.ledgerRetentionMonths,
    monthStartDay: config.monthStartDay,
  })

  return {
    ok: true,
    now,
    today,
    provider,
    balance: balanceView(resolved.state),
    balanceReason: resolved.state === null ? (resolved.reason || 'warming') : undefined,
    month: {
      from: month.from,
      to: month.to,
      monthStartDay: month.monthStartDay,
      amount: month.amount,
      amountUnits: month.amountUnits,
      currency: month.currency,
      mixedCurrency: month.mixedCurrency,
      byCurrency: month.byCurrency,
      /* 分来源的区间小计：客户端的「本月」明细照它列出每个账户各花了多少。 */
      sources: month.sources,
      observedDays: month.observedDays,
      missingDays: month.missingDays,
      incompleteDays: month.incompleteDays,
      needsReviewDays: month.needsReviewDays,
      unobservedScopes: month.unobservedScopes,
      hasGap: month.hasGap,
      hasAnyObservation: month.hasAnyObservation,
    },
    todayReal: todayReal === null ? null : todayReal,
    todayTurns,
    monthTurns,
    history,
    ledger: {
      active: ledger.active,
      /* 估算轮次现在跨全部本读取（见 turnsAcrossBooks），所以这里由「某一本」改成聚合标记。 */
      scope: 'all',
      books: scopesOf(ledger).length,
      bytes: deps.balance.bytes(),
      recovered: deps.balance.recovered(),
      lastError: deps.balance.lastError(),
      /* 账本文件路径解析失败时为 true：客户端据此把「今日/本月」显示成「宿主不可用」，
         而不是把它当成「消费 0 元」—— 两者必须区分（决策 #7）。 */
      unavailable: deps.ledgerUnavailable === true,
      retentionMonths: prune.retentionMonths,
      nextPruneDay: prune.nextPruneDay,
      keepFrom: prune.keepFrom,
      /* 账本里的天数 = **全部本**的天数之和（多来源下按一本算会少报）。 */
      dayCount: scopesOf(ledger).reduce((total, scope) => {
        const book = ledger.books[scope]
        return total + Object.keys((book && book.days) || {}).length
      }, 0),
    },
    /**
     * 宿主侧**实际生效**的余额来源统计。
     *
     * 存在的唯一理由：设置页保存后要能**核实**这份配置真的到了宿主。
     * 2026-10-06 的 bug 是「设置页存进了浏览器、宿主配置里一条来源都没有」，
     * 界面显示保存成功、汇总行的余额却永远是 —。客户端拿这段数字对账，
     * 对不上就直接告诉用户「这次保存没写进宿主配置」。
     */
    balanceSources: {
      total: Array.isArray(config.balanceSources) ? config.balanceSources.length : 0,
      enabled: (Array.isArray(config.balanceSources) ? config.balanceSources : [])
        .filter((source) => source && source.enabled).length,
      refs: (Array.isArray(config.balanceSources) ? config.balanceSources : [])
        .map((source) => String((source && source.credentialRef) || '')),
    },
    /**
     * 最近一次「余额观测入账」的结果。
     *
     * 存在的理由：**取余额成功 ≠ 账本里有了观测**。观测可能被账本拒绝
     * （币种不是 3 位 ISO 码、金额为负、重复样本…），旧实现只写一行 `logger.warn` ——
     * 于是「界面余额显示正常、账本里一条观测都没有、今日真实花费恒为 ¥0.00」
     * 这种故障在界面上完全看不见（2026-10-06 的第四层 bug）。
     */
    lastObservation: typeof deps.balance.lastObservation === 'function' ? deps.balance.lastObservation() : null,
    /**
     * 余额运行时的可观测出口（照 AGENTS §12 的方法论：每一层都要有自己的出口）。
     *
     * `credentialsAvailable`：`null` = 还没试过、`true` = 拿到了宿主的凭据服务、
     * `false` = 这一刻拿不到（重载窗口里会发生；管理器会自动重试）。
     * 有它才能区分「用户没配密钥」（`balance.reason = no-key`）与
     * 「插件没拿到凭据服务」（`balance.reason = no-credentials-service`）——
     * 两者在界面都是「余额 —」，混在一起就会像 2026-10-06 那样误诊。
     */
    balanceRuntime: {
      credentialsAvailable: typeof deps.balance.credentialsAvailable === 'function'
        ? deps.balance.credentialsAvailable()
        : null,
    },
  }
}

/**
 * 读当前配置。
 *
 * ⚠️ **取配置的唯一正确姿势是 `ctx.fiber.config`**（2026-10-05 三层误诊换来的）：
 *
 *   ① `ctx.config` **不声明 inject 就抛** `cannot get property "config" without inject`
 *      —— Cordis 的 ctx 是 Proxy，未声明的属性一律拒绝（cordis/lib/index.js:676）。
 *   ② 于是把 `'config'` 写进 `inject` —— 结果条目卡成 **pending**：那不是服务名，
 *      `Fiber._refresh()` 找不到注入项就把 fiber 置为 INACTIVE。
 *   ③ 正解：`config` 是 **Fiber 自己的普通属性**（构造函数里 `this.config`，
 *      由 `_resolveConfig()` 解析后赋值；`ctx.fiber` 本身也是 own property）。
 *      走普通属性读取既**不需要 inject**，也**不会**把条目卡住。
 *
 * 根级 `.volatile()` 的代价：`fiber.config` 的**字段值是 Volatile 引用**，
 * 需要 `.get()` 才拿到普通值 —— 保留原有的 unwrap 逻辑。
 *
 * `ctx.config` 分支仅作兜底（旧写法/别处传进来的 ctx），失败就返回 `{}`：
 * 宿主半体的任何未捕获异常都会让整个条目 inactive，所以这里绝不抛。
 */
function readConfig(ctx) {
  function unwrap(value) {
    if (value && typeof value === 'object' && typeof value.get === 'function' && typeof value.toJSON !== 'function') {
      try { return unwrap(value.get()) } catch (err) { return value }
    }
    return value
  }
  /** 三种来源按可靠性排序；每个都可能抛（Proxy 门禁），所以各自包一层。 */
  function candidates() {
    const list = []
    try {
      const fiber = ctx && ctx.fiber
      if (fiber && fiber.config) list.push(fiber.config)
    } catch (err) { /* 无 fiber（例如测试里的假 ctx） */ }
    try {
      if (ctx && ctx.config) list.push(ctx.config)
    } catch (err) { /* 未声明 inject → 抛，忽略 */ }
    return list
  }
  try {
    let raw = null
    for (const candidate of candidates()) {
      const plain = unwrap(candidate)
      if (plain && typeof plain === 'object' && Object.keys(plain).length > 0) { raw = plain; break }
    }
    if (!raw) return {}
    /* 逐字段取值：根级 volatile 让每个字段都是引用。 */
    const out = {}
    for (const key of Object.keys(raw)) out[key] = unwrap(raw[key])
    return out
  } catch (err) {
    return {}
  }
}

/**
 * 安全地取一个服务。
 *
 * ⚠️ `ctx.get()` 在服务不可用/正在重载时**可能抛错**。宿主半体的任何一次未捕获异常
 * 都会让这个插件条目变成 inactive（AGENTS §6 的历史事故路径），所以所有服务访问
 * 都走这里：取不到就返回 `null`，由调用方降级。
 *
 * ⚠️ 服务**晚一步就绪**是本机的常态，不是异常（2026-10-05 冷启动实测：`webServer` 与
 * `credentials` 在 apply() 那一刻都还取不到，约 1 秒后才出现）。所以调用方必须能
 * 「先降级、等就绪后再接上」——见 `attachBalance()` 与路由的有界重试。
 * 这里只返回 null，**不打日志**：拿不到是预期路径，刷日志反而掩盖真问题。
 */
function safeGet(ctx, name) {
  try {
    if (!ctx || typeof ctx.get !== 'function') return null
    return ctx.get(name) ?? null
  } catch (err) {
    return null
  }
}

/**
 * 注册 `/dsh-turn-price/*` 路由。
 *
 * 用一个 **prefix** 路由覆盖全部端点（而不是每个端点一条 exact）：少一条路由就少
 * 一个「(kind,path) 重复注册会抛」的失败面，也方便后续加端点。
 */
function registerRoutes(ctx, deps) {
  const config = () => Object.assign({}, readConfig(ctx))

  const route = {
    kind: 'prefix',
    path: ROUTE_PATH,
    async handler(req, res) {
      const path = pathnameOf(req)
      const method = String((req && req.method) || 'GET').toUpperCase()
      try {
        if (path === ROUTE_PREFIX + '/ping.json') {
          return sendOk(res, {
            pid: process.pid,
            version: 1,
            cachedSessions: deps.cache.size,
            ledger: deps.ledgerFile,
            /* 账本路径解析失败（理论上只会在连主目录都拿不到时发生）为 true：
               客户端据此把宿主段显示成「宿主不可用」，而不是当成「消费 0 元」。 */
            ledgerUnavailable: deps.ledgerUnavailable === true,
            path: ROUTE_PATH,
          })
        }

        if (path === ROUTE_PREFIX + '/usage.json') {
          const rawSessionId = queryOf(req, 'sessionId')
          if (rawSessionId === null || rawSessionId === '') return sendFail(res, 'no-session', 400)
          return sendJson(res, 200, await usagePayload(ctx, deps, rawSessionId))
        }

        if (path === ROUTE_PREFIX + '/state.json') {
          const sessionId = queryOf(req, 'sessionId') || ''
          const providerHint = queryOf(req, 'provider') || ''
          return sendJson(res, 200, statePayload(ctx, deps, config(), sessionId, providerHint))
        }

        if (path === ROUTE_PREFIX + '/daily.json') {
          /* 日历图数据源：`?month=YYYY-MM`（省略则用记账月）。 */
          return sendJson(res, 200, dailyPayload(deps, config(), queryOf(req, 'month')))
        }

        if (path === ROUTE_PREFIX + '/refresh') {
          if (method !== 'POST') return sendFail(res, 'method-not-allowed', 405)
          await readJsonBody(req)
          const what = queryOf(req, 'what') || 'all'
          if (what === 'balance' || what === 'all') await deps.balance.refreshNow(config())
          const sessionId = queryOf(req, 'sessionId') || ''
          const providerHint = queryOf(req, 'provider') || ''
          return sendJson(res, 200, statePayload(ctx, deps, config(), sessionId, providerHint))
        }

        if (path === ROUTE_PREFIX + '/test-connection') {
          if (method !== 'POST') return sendFail(res, 'method-not-allowed', 405)
          const body = (await readJsonBody(req)) || {}
          const cfg = config()
          /* 草稿参数优先；没给 key 就用凭据名解析（设置页「测试」按钮的两种用法）。 */
          let key = typeof body.apiKey === 'string' ? body.apiKey : ''
          let keyRef = typeof body.credentialRef === 'string' ? body.credentialRef : ''
          if (key === '' && keyRef !== '') {
            /* 先用 describe 判断「到底配没配」：没配就直接回 no-key，
               不要拿空密钥去打一次真实网络（慢 + 会刷出无意义的 401）。 */
            const credentials = safeGet(ctx, 'credentials')
            const info = await describeCredential(credentials, keyRef)
            if (!info.configured) {
              return sendJson(res, 200, {
                ok: false,
                reason: 'no-key',
                reasonText: '凭据 ' + keyRef + ' 还没有配置',
              })
            }
            key = await resolveCredential(ctx, keyRef)
          }
          const result = await testConnection({ fetch: deps.fetch }, {
            adapter: body.adapter,
            key,
            baseUrl: body.baseUrl,
            label: body.label,
            timeoutMs: body.timeoutMs || cfg.balanceTimeoutMs,
            currency: body.currency || cfg.currency,
          })
          return sendJson(res, 200, {
            ok: result.ok === true,
            reason: result.reason,
            reasonText: result.reasonText,
            kind: result.kind,
            amount: result.amount,
            currency: result.currency,
            windows: result.windows,
            level: result.level,
            probe: result.probe,
            /* 原始返回**摘要**（截断，避免把整包塞给浏览器；密钥不会出现在响应里）。 */
            rawSummary: summarizeRaw(result.raw),
          })
        }

        if (path === ROUTE_PREFIX + '/correction') {
          if (method !== 'POST') return sendFail(res, 'method-not-allowed', 405)
          const body = (await readJsonBody(req)) || {}
          const cfg = config()
          const tzOffset = Number(cfg.tzOffset ?? 8)
          const ledger = deps.balance.getLedger()
          /**
           * 校正**必须落在具体某一本账上**（多来源下 `ledger.active` 可能不是用户在看的那本）。
           * 客户端从 `days[].correctionScope` / `sources[].scope` 回传 scope；
           * 没给时退回「这一天第一个已观测的来源」——这样单来源用户的旧调用行为不变，
           * 多来源用户也不会把校正误写进别的账户。
           */
          let scope = String(body.scope || '')
          if (scope === '') {
            const day = aggregateDaySummary(ledger, String(body.day || ''), { tzOffset, now: deps.now() })
            scope = day && day.correctionScope ? day.correctionScope : String(ledger.active || '')
          }
          try {
            const summary = reconcileBalance(ledger, {
              day: body.day,
              credits: body.credits,
              otherDebits: body.otherDebits,
              revision: body.revision,
              confirmed: body.confirmed,
              action: body.action,
              scope,
              tzOffset,
            }, deps.now())
            deps.balance.markDirty()
            deps.balance.flush()
            return sendOk(res, { day: summary, scope })
          } catch (err) {
            return sendFail(res, 'correction-failed', err && err.status === 409 ? 409 : 200, err && err.message ? err.message : String(err))
          }
        }

        if (path === ROUTE_PREFIX + '/credentials') {
          if (method !== 'POST') return sendFail(res, 'method-not-allowed', 405)
          return credentialsEndpoint(ctx, req, res, (await readJsonBody(req)) || {})
        }

        if (path === ROUTE_PREFIX + '/ledger') {
          const ledger = deps.balance.getLedger()
          /* `?export=1` 给设置页的「导出日账 JSON」（只导日账，不含任何凭据）。
             ⚠️ 多来源之后导出**全部本**：只导 `ledger.active` 会让用户以为
             「另一个账户的记录丢了」（`days` 仍保留 = 当前本的日行，向后兼容）。 */
          if (queryOf(req, 'export') === '1') {
            const book = ledger.books[ledger.active] || null
            return sendOk(res, {
              version: ledger.version,
              exportedAt: deps.now(),
              active: ledger.active,
              provider: book ? book.provider : '',
              currency: book ? book.currency : '',
              days: book ? book.days : {},
              books: ledger.books,
            })
          }
          return sendOk(res, { version: ledger.version, active: ledger.active, books: ledger.books })
        }

        if (path === ROUTE_PREFIX + '/ledger/clear') {
          if (method !== 'POST') return sendFail(res, 'method-not-allowed', 405)
          const body = (await readJsonBody(req)) || {}
          const what = String(body.what || 'estimates')
          const ledger = deps.balance.getLedger()
          let cleared = 0
          for (const scope of Object.keys(ledger.books)) {
            const book = ledger.books[scope]
            if (!book || !book.days) continue
            for (const day of Object.keys(book.days)) {
              if (what === 'all') {
                delete book.days[day]
                cleared += 1
              } else if (Array.isArray(book.days[day].turns) && book.days[day].turns.length) {
                book.days[day].turns = []
                cleared += 1
              }
            }
          }
          deps.balance.markDirty()
          deps.balance.flush()
          return sendOk(res, { what, cleared })
        }

        if (method === 'POST') await readJsonBody(req)
        return sendFail(res, 'unknown-endpoint', 404, path)
      } catch (err) {
        return sendFail(res, 'internal', 500, err && err.message ? err.message : String(err))
      }
    },
  }

  const webServer = safeGet(ctx, 'webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    /* 服务还没就绪（冷启动竞态的常态）。**这不是错误**：调用方（applyInner 里的
       effect）会按 800ms 的节奏重试，最多 30 次；非 web profile 则永远拿不到，
       客户端会把宿主段降级显示成 —。 */
    return null
  }
  try {
    return webServer.register(route)
  } catch (err) {
    /* 注册失败（重复路径、宿主正在重载）不该让插件崩掉：没有路由时客户端会把宿主段
       显示成 —，轮尾金额仍走客户端回退路径。 */
    if (typeof ctx.logger?.warn === 'function') {
      ctx.logger.warn('turn-cost: 路由注册失败：%s', err && err.message ? err.message : String(err))
    }
    return null
  }
}

/** 解析一个凭据名（密钥只在宿主内存里用，**绝不**回给浏览器）。 */
async function resolveCredential(ctx, ref) {
  const credentials = safeGet(ctx, 'credentials')
  const resolved = await resolveCredentialValue(credentials, ref)
  return resolved.value
}

/**
 * 凭据管理端点（设置页卡片 2 用）。
 *
 * 三个硬约束（§10.1 / §12）：
 *   · **永不回显密钥** —— `describe` 只给 configured / source / writable；
 *   · 写入用 `credentials.set(ref, value)`，**不进 Config**、不进账本；
 *   · 空值走 `unset`（`set` 会拒绝空值）。
 *
 * ⚠️ **绝不覆盖模型 provider 的密钥**（2026-10-06 事故事后加固）：
 * 余额适配器建议的凭据名（`DEEPSEEK_API_KEY` 等）**同时就是模型在用的密钥名**。
 * 用户在「账户与余额」页点「替换密钥」时，旧实现直接把新值写进这个名字 ——
 * 于是模型密钥被悄悄换掉，用户随后到官方平台删掉那把（他以为没用的）密钥，
 * 整个对话立刻 `AUTH 401 密钥无效`。现在写这些名字会**改道**成余额专用名字。
 */
async function credentialsEndpoint(ctx, req, res, body) {
  const credentials = safeGet(ctx, 'credentials')
  if (!credentials) return sendFail(res, 'no-credentials-service', 200, '凭据服务不可用')
  const action = String((body && body.action) || 'describe')
  const ref = String((body && body.ref) || '').trim()
  if (ref === '') return sendFail(res, 'no-ref', 400)

  if (action === 'describe') {
    const info = await describeCredential(credentials, ref)
    return sendOk(res, { ref, ...info, moved: false })
  }
  if (action === 'set') {
    const value = typeof body.value === 'string' ? body.value : ''
    /* 受保护的 provider 密钥：改成余额专用名字写，并让客户端把来源指过去。 */
    const target = isProviderCredentialRef(ref) ? balanceKeyRefFor(ref) : ref
    if (value === '') {
      /* 空值 = 清除（set 明确拒绝空值，必须走 unset）。 */
      try {
        await credentials.unset(target)
        return sendOk(res, { ref: target, cleared: true, moved: target !== ref, movedFrom: ref })
      } catch (err) {
        return sendFail(res, 'unset-failed', 200, err && err.message ? err.message : String(err))
      }
    }
    try {
      await credentials.set(target, value)
      const info = await describeCredential(credentials, target)
      return sendOk(res, { ref: target, ...info, moved: target !== ref, movedFrom: ref })
    } catch (err) {
      /* 只读来源遮蔽、或写入被拒 —— 如实报告，不假装成功。 */
      return sendFail(res, 'set-failed', 200, err && err.message ? err.message : String(err))
    }
  }
  if (action === 'unset') {
    const target = isProviderCredentialRef(ref) ? balanceKeyRefFor(ref) : ref
    try {
      await credentials.unset(target)
      return sendOk(res, { ref: target, configured: false, moved: target !== ref, movedFrom: ref })
    } catch (err) {
      return sendFail(res, 'unset-failed', 200, err && err.message ? err.message : String(err))
    }
  }
  return sendFail(res, 'unknown-action', 400, action)
}

/**
 * 模型 provider 的密钥名白名单（**绝不允许**被余额设置页覆盖）。
 *
 * 两个来源：
 *   1. 本机 profile 里实际在用的 provider 配置 —— `dsh-llm-pi-ai` 的
 *      `providers.zai.apiKeyEnv: ZAI_API_KEY`（见 `cordis.patch.yml`），
 *      以及 DeepSeek 官方 provider 的 `DEEPSEEK_API_KEY`；
 *   2. 余额适配器表建议的凭据名（`adapterCredentialRefs()`）—— 它们和 provider
 *      读的密钥名是同一批，改适配器表时自动跟着变。
 *
 * 常量化在源码里而不是从 Config 推导：这是一条**安全兜底**，
 * 用户把配置改坏了也不能让「替换余额密钥」毁掉模型密钥。
 */
const PROVIDER_CREDENTIAL_REFS = ['DEEPSEEK_API_KEY', 'ZAI_API_KEY']

/**
 * 该凭据名是不是「模型 provider 在用的密钥」。
 */
export function isProviderCredentialRef(ref) {
  const want = String(ref || '').trim().toUpperCase()
  if (want === '') return false
  const all = PROVIDER_CREDENTIAL_REFS.concat(adapterCredentialRefs())
  return all.some((item) => String(item).trim().toUpperCase() === want)
}

/** 受保护名字 → 余额专用名字（`DEEPSEEK_API_KEY` → `TURN_COST_BALANCE_DEEPSEEK_API_KEY`）。 */
export function balanceKeyRefFor(ref) {
  return 'TURN_COST_BALANCE_' + String(ref || '').trim()
}

/** 原始返回摘要：只留结构骨架，避免把大对象整包回传。 */
function summarizeRaw(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object') return String(raw).slice(0, 200)
  try {
    const text = JSON.stringify(raw)
    return text.length > 600 ? text.slice(0, 600) + '…' : text
  } catch (err) {
    return '[无法序列化]'
  }
}

/**
 * 宿主半体：声明 Config（设置表单由框架投影）+ 折叠每轮用量 + 暴露 `/dsh-turn-price/*`。
 *
 * 设计边界（IMPLEMENTATION-PROMPT §4）：
 *   · **计价只有一份**，在客户端。宿主只提供事实（token 桶、路由、余额、观测时刻）；
 *   · **每轮的 token 折叠只有一份**，在这里（`lib/session-usage.js`）——
 *     不再用 DSH 自带的严格折叠，因为它对 15/77 个真实回合直接判「不可证」。
 *
 * ⚠️ `apply` 写成 `const` 箭头函数是因为 2026-10-05 的一次**排错实验**
 * （当时误以为「函数声明 vs const」影响激活）。结论：**导出形态不是根因**，
 * 真正的原因是 Config 校验失败（见 promoSchema 与 readConfig 的注释）。
 * 形态保留现状即可，**不必**为了"更规范"改回函数声明 —— 两者行为等价。
 */
const apply = (ctx) => {
  try {
    return applyInner(ctx)
  } catch (err) {
    /* 装配期异常必须留痕：Cordis 只在**启动审计**时才打印真正的失败原因
       （`inactiveEntries()`），而热重载/启停切换时不会。
       这里用 ctx.logger 记一份，然后照样抛出去 —— 不吞异常，行为与不包 try 一致。 */
    try {
      if (typeof ctx?.logger?.error === 'function') {
        ctx.logger.error('turn-cost: apply 失败：%s', err && err.stack ? err.stack : String(err))
      }
    } catch (inner) { /* 记日志本身绝不能再抛 */ }
    throw err
  }
}

export { apply }

function applyInner(ctx) {
  const cache = createUsageCache()
  const config = () => readConfig(ctx)

  /** 统一的降级日志（宿主半体的任何未捕获异常都会让整条插件 inactive）。 */
  function softFail(where, err) {
    const text = err && err.message ? err.message : String(err)
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn('turn-cost: %s 失败：%s', where, text)
    return null
  }

  /* ── 账本 + 余额管理器 ─────────────────────────────────────────────── */
  /* 不在这里传 `process.env.DSH_HOME`：宿主进程里它是 undefined（bug #4），
     让 ledgerPathOf 自己按 `DSH_HOME || os.homedir()/.dsh` 解析。

     ⚠️ 这一段**每一步都单独兜住**（bug #4 的教训）：以前 ledgerPathOf 一抛，
     异常直接冒出 apply() → 整个条目 inactive → 路由全 404。
     账本/余额是**附加功能**，它们坏掉绝不该让「每轮金额」这个主功能一起死。 */
  let ledgerFile = null
  try {
    ledgerFile = ledgerPathOf()
  } catch (err) {
    softFail('ledgerPathOf', err)
  }
  /**
   * 余额/账本的空实现。
   *
   * 为什么不用 `null`：`deps.balance.*` 在文件里有近 20 个调用点，
   * 逐个加 `?.`/判空既啰嗦又容易漏一处（漏一处就是一个新的"整条 inactive"）。
   * 空实现让**所有调用点原样可用**，只是不记账、不刷新、不报错 ——
   * 主功能（每轮金额、路由）完全不受影响。
   */
  const EMPTY_BALANCE = {
    load() {}, flush() {}, markDirty() {}, bytes: () => 0, recovered: () => null,
    lastError: () => null, lastObservation: () => null,
    refreshNow: async () => ({ ok: false, reason: 'balance-unavailable' }),
    refreshAll: async () => ({ ok: false, reason: 'balance-unavailable' }),
    resolveForProvider: () => null, describeCredential: null,
    getLedger: () => ({ version: 1, active: '', books: {} }),
    start() {}, stop() {},
  }

  const deps = {
    cache,
    /* 先给空实现，等 webServer/credentials 就绪后再换成真的（见 attachBalance）。 */
    balance: EMPTY_BALANCE,
    ledgerFile,
    ledgerUnavailable: ledgerFile === null,
    fetch: typeof fetch === 'function' ? fetch : null,
    now: () => Date.now(),
    lastProvider: '',
  }

  /**
   * 建真正的余额管理器并启动定时刷新。
   *
   * ⚠️ **必须晚到服务就绪之后再调**（2026-10-05 冷启动实测）：
   * `credentials` 和 `webServer` 一样是**晚一步**才注册进本上下文的
   * （冷启动日志：`safeGet:absent credentials` / `safeGet:absent webServer`，
   * 约 1 秒后才出现）。原来在 applyInner 开头就取 credentials 并建管理器，
   * 于是冷启动那次拿到的是 `undefined` —— 余额/凭据功能整个失效，且毫无报错。
   *
   * 用 `deps.balance` 原地替换：文件里近 20 个 `deps.balance.*` 调用点自动跟着换，
   * 不需要各自感知「何时就绪」。
   */
  function attachBalance() {
    try {
      if (ledgerFile === null) throw new Error('账本路径不可用，余额/日账功能降级')
      const real = createBalanceManager({
        fetch: typeof fetch === 'function' ? fetch : null,
        fs: nodeFs,
        /**
         * ⚠️ **绝不在这里把 `credentials` 取出来存下来**（2026-10-06 的第二次事故）：
         * 保存设置会让本条目重载，重载窗口里 `ctx.get('credentials')` 是 null ——
         * 存下来就是**永久** `no-key`，界面显示「余额 —」且文案误导成「没有配置密钥」，
         * 只有停用/启用一次插件才能恢复（= 重建管理器）。
         * 现在每次取余额都重新取服务（管理器内部还有约 1.5 秒的有界重试 + 15 秒补试）。
         */
        credentialsProvider: () => safeGet(ctx, 'credentials'),
        now: () => Date.now(),
        ledgerFile,
        logger: {
          warn: (message, detail) => {
            if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(message, detail)
          },
        },
      })
      real.load()
      deps.balance = real
    } catch (err) {
      softFail('余额管理器初始化', err)
      /* 保持 EMPTY_BALANCE：功能降级，但插件照常工作。 */
    }
    try { deps.balance.start(config()) } catch (err) { softFail('余额定时刷新启动', err) }
    /* 启动时先取一轮余额（不阻塞：失败只留日志）。 */
    Promise.resolve()
      .then(() => deps.balance.refreshAll(config()))
      .catch((err) => {
        if (typeof ctx.logger?.warn === 'function') ctx.logger.warn('turn-cost: 首次取余额失败：%s', err && err.message ? err.message : String(err))
      })
  }

  /* ── 每轮用量：增量折叠 + 回填 ─────────────────────────────────────── */
  ctx.effect(() => {
    return ctx.on('session/event', (session, event) => {
      try {
        if (!session || typeof session.id !== 'string' || !event || typeof event.type !== 'string') return
        const entry = cacheEntry(cache, session.id)
        const seq = typeof event.seq === 'number' ? event.seq : null
        /* 严格连续才算「覆盖了开头」。有跳号说明中间的事件我们没看到（插件是后
           加载的，或缓存是被增量先建起来的），标记不完整，下次请求走 readSession 回填。 */
        if (!entry.complete && entry.state.seenThroughSeq >= 0 && seq !== null && seq > entry.state.seenThroughSeq + 1) {
          entry.source = 'gap'
        }
        if (seq !== null && seq <= entry.state.seenThroughSeq) return
        foldEvents(entry.state, [event])

        /* ── 估算账入账：只在 turn/end 时写，按 `sessionId:endSeq` 幂等 upsert ──
           时区用插件的 tzOffset（与轮尾计费时刻同一套逻辑），不用宿主本地时区。 */
        if (event.type === 'turn/end') {
          const cfg = config()
          const turn = turnsOf(entry.state).find((item) => item.turn === event.data.turn)
          recordTurnEstimate(deps, ctx, cfg, session.id, turn, event.time)
        }
      } catch (err) {
        /* 折叠失败不能让宿主出问题：留日志，等下次请求回填。 */
        if (typeof ctx.logger?.warn === 'function') ctx.logger.warn('turn-cost: fold failed: %s', err && err.message ? err.message : String(err))
      }
    })
  }, 'turn-cost: session usage feed')

  /* 会话释放：清掉缓存，避免长跑进程攒内存。 */
  ctx.effect(() => {
    return ctx.on('session/disposed', (session) => {
      if (session && typeof session.id === 'string') cache.delete(session.id)
    })
  }, 'turn-cost: session usage eviction')

  /* ── 启动回填：把「插件启动之前」的回合补进估算账 ────────────────────
     ⚠️ 这是用户 2026-10-05 报的 bug：他只看到 17:42 之后的估算金额，
     而更早（16:02–17:29）还有 6 个回合没被算进去。

     根因：原来的回填是**惰性**的 —— 只有某个会话被打开（`/usage.json` 被请求）
     才回填它，从不遍历。所以「今天开过但没再打开」的会话永远不进账本。

     修法：启动后**一遍**扫描最近创建的会话并折进估算账。边界（都是刻意设的）：
       · 只处理 `createdAt` 在 `BACKFILL_DAYS` 天内的会话 —— 不扫全库；
       · 最多 `BACKFILL_MAX_SESSIONS` 个、总耗时上限 `BACKFILL_BUDGET_MS`；
       · **不阻塞 `apply()`**（`Promise.resolve().then(...)`），也不碰路由注册；
       · 单个会话失败只跳过它，绝不影响别的会话与插件本身。 */
  ctx.effect(() => {
    let stopped = false
    const BACKFILL_DAYS = 2
    const BACKFILL_MAX_SESSIONS = 40
    const BACKFILL_BUDGET_MS = 20000

    async function backfillRecent() {
      const sessionQuery = safeGet(ctx, 'sessionQuery')
      if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') return
      const started = Date.now()
      let records = []
      try {
        records = await sessionQuery.listSessions()
      } catch (err) {
        softFail('列出会话（回填）', err)
        return
      }
      if (!Array.isArray(records)) return
      const cutoff = Date.now() - BACKFILL_DAYS * 86400000
      let done = 0
      for (const record of records) {
        if (stopped) return
        if (done >= BACKFILL_MAX_SESSIONS) break
        if (Date.now() - started > BACKFILL_BUDGET_MS) break
        const header = record && record.header
        const id = header && typeof header.id === 'string' ? header.id : ''
        if (id === '') continue
        /* 只要「最近创建」的：老会话不可能有今天的回合，读了纯粹浪费。 */
        if (typeof header.createdAt === 'number' && header.createdAt < cutoff) continue
        const entry = cacheEntry(cache, id)
        /* 已经完整折过的就跳过（增量路径可能已经覆盖）。 */
        if (entry.complete) continue
        try {
          const snapshot = await sessionQuery.readSession(id)
          if (stopped) return
          refillSession(deps, ctx, readConfig(ctx), cache, id, snapshot && Array.isArray(snapshot.events) ? snapshot.events : [])
          done += 1
        } catch (err) {
          /* 单个会话读不了就跳过 —— 它不该影响别的会话，也不该影响插件。 */
          if (typeof ctx.logger?.debug === 'function') {
            ctx.logger.debug('turn-cost: 回填跳过 %s：%s', id, err && err.message ? err.message : String(err))
          }
        }
      }
      if (done > 0 && typeof ctx.logger?.info === 'function') {
        ctx.logger.info('turn-cost: 启动回填完成，补入 %s 个会话的回合', done)
      }
    }

    Promise.resolve().then(backfillRecent).catch((err) => softFail('启动回填', err))
    return () => { stopped = true }
  }, 'turn-cost: startup backfill')

  /* ── HTTP 路由 + 余额定时刷新 ────────────────────────────────────────
     ⚠️ **必须带重试**（2026-10-05 实测的冷启动竞态）：冷启动那次 apply() 里
     `ctx.get('webServer')` 返回 null —— 那时 webserver 条目还是 active 但服务尚未
     注册进本上下文；而热重载时它已经在了。结果：冷启动没有路由（客户端 404），
     热重载却正常。用户每次重启都会撞上。

     这里做**有界重试**（最多 30 次 / 约 24 秒）：服务一出现就注册路由并启动余额刷新；
     始终拿不到就放弃并留日志（非 web profile 属于正常情况，客户端会降级显示 —）。
     重试循环不阻塞 apply()，fiber 也不会停在 pending。 */
  ctx.effect(() => {
    let stopped = false
    let routeDispose = undefined
    let routesReady = false

    /**
     * 同步试一次注册。**快路径：热重载 / 服务已就绪时立刻拿到路由**，
     * 这样 `apply()` 返回时路由已经就位（离线测试与既有调用方都依赖这个契约）。
     * 成功时顺带把**晚就绪的服务**（credentials）真正接上 —— 见 attachBalance 的注释。
     * @returns 是否已经拿到路由
     */
    function tryAttachOnce() {
      const dispose = registerRoutes(ctx, deps)
      if (typeof dispose !== 'function') return false
      routeDispose = dispose
      routesReady = true
      attachBalance()
      return true
    }

    /* ① 快路径：同步注册。 */
    if (tryAttachOnce()) return () => teardown()

    /* ② 慢路径：冷启动竞态 —— webserver 条目 active 但服务尚未注册进本上下文。
       有界重试（最多 30 次 / 间隔 800ms，约 24 秒），拿到就注册；始终拿不到就放弃并留日志
       （非 web profile 属正常情况，客户端会把宿主段显示成 —）。 */
    async function retryAttach() {
      for (let attempt = 2; attempt <= 30 && !stopped && !routesReady; attempt++) {
        await new Promise((resolve) => { setTimeout(resolve, 800) })
        if (stopped) return
        if (tryAttachOnce()) return
      }
      if (!routesReady && !stopped) {
        if (typeof ctx.logger?.warn === 'function') {
          ctx.logger.warn('turn-cost: 拿不到 webServer，HTTP 端点未注册（客户端会降级显示）')
        }
        /* 路由没有也要把余额/凭据接上：轮尾金额与设置页仍然要用。 */
        attachBalance()
      }
    }
    Promise.resolve().then(retryAttach).catch((err) => softFail('路由注册重试', err))

    function teardown() {
      stopped = true
      if (typeof routeDispose === 'function') {
        try { routeDispose() } catch (err) { /* 已经释放过 */ }
      }
      try { deps.balance.stop() } catch (err) { /* 释放失败不影响卸载 */ }
      cache.clear()
    }
    return teardown
  }, 'turn-cost: http routes')
}

/**
 * 额外的默认导出（`{ name, inject, Config, apply }`），与命名导出**并存**。
 *
 * ⚠️ 事实澄清（2026-10-05 实测，别再重复这个错）：
 * 曾以为「只有命名导出」是端点 404 的根因，于是加了默认导出 —— **行为完全没变**。
 * 所以**导出形态不是根因**。反证很硬：本机 `dsh-plugin-notify-sound` 用的是
 * 纯命名导出，照样正常工作。真正的根因是 **Config 校验失败**（见 promoSchema 注释）。
 *
 * 保留默认导出无害，且与 `dsh-whale-widget` 的写法一致；但**不要**再拿它解释激活问题。
 */
export default { name, inject, Config, apply }
