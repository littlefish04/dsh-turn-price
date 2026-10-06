/**
 * dsh-turn-cost — 余额运行时（宿主侧）
 *
 * 职责：把「配置里的余额来源」变成「当前账本 + 最近一次取数结果」。
 *
 * 分工（照 IMPLEMENTATION-PROMPT §4 的边界）：
 *   · 本文件只负责**取事实**：密钥从 `ctx.credentials` 解析、按适配器取余额/额度、
 *     把观测写进账本（`lib/ledger.js`）、处理定时刷新与去抖；
 *   · **不算钱**：金额计算在客户端（唯一的计价实现）。
 *
 * 所有外部依赖（credentials / fetch / 文件系统 / 定时器 / 时钟）都从参数注入，
 * 这样离线测试可以完全不碰网络与磁盘（见 `tools/test-balance-runtime.mjs`）。
 */

import { createHash } from 'node:crypto'
import { fetchBalance, adapterOf, failureText, isNoCodingPlanError, probeConnection } from './balance.js'
import {
  emptyLedger,
  isLedgerShape,
  ledgerBytesSync,
  loadLedgerSync,
  observeBalance,
  saveLedgerSync,
  scopeKeyOf,
} from './ledger.js'

/**
 * 解析一个凭据名。
 *
 * ⚠️ **`credentials.resolve(ref)` 返回的是 `{value, source}`，不是字符串**
 * （已用 `cordis_inspect_query(host, Service, listService)` 核对：
 * `resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>`）。
 * 早期版本把它当字符串用，会让每次取余额都带上 `[object Object]` 当密钥 ——
 * 这里是唯一解析入口，别再在别处直接调 `resolve`。
 *
 * @returns `{value, source}`；未配置时 value 为空串
 */
export async function resolveCredentialValue(credentials, ref) {
  if (!credentials || typeof credentials.resolve !== 'function' || !ref) return { value: '', source: '' }
  try {
    const resolved = await credentials.resolve(ref)
    if (typeof resolved === 'string') return { value: resolved, source: '' } // 兼容更老的形态
    if (resolved && typeof resolved.value === 'string') {
      return { value: resolved.value, source: typeof resolved.source === 'string' ? resolved.source : '' }
    }
    return { value: '', source: '' }
  } catch (err) {
    return { value: '', source: '' }
  }
}

/** 描述一个凭据名（给设置页看：configured / source / writable），**不回显值**。 */
export async function describeCredential(credentials, ref) {
  if (!credentials || typeof credentials.describe !== 'function' || !ref) {
    return { configured: false, source: '', writable: false }
  }
  try {
    const info = await credentials.describe(ref)
    return {
      configured: info && info.configured === true,
      source: info && typeof info.source === 'string' ? info.source : '',
      writable: info && info.writable === true,
    }
  } catch (err) {
    return { configured: false, source: '', writable: false }
  }
}

/** 密钥指纹：sha256 前 8 位（换 key 就换一本账，避免旧基线污染新账户）。 */
export function fingerprintOf(key) {
  if (!key) return 'nokey'
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 8)
}

/**
 * 从配置里挑出「与当前会话路由匹配」的来源。
 *
 * 规则（照 §10.1）：
 *   1. `enabled` 且 `providerIds` 命中当前 provider → 用第一个命中的；
 *   2. 没命中、但**只配了一个**启用的来源 → 用它（用户只填了一个就是在说"就用这个"）；
 *   3. 其余 → `null`（界面显示 `余额 —`）。
 */
export function pickSource(sources, provider) {
  const enabled = (Array.isArray(sources) ? sources : []).filter((source) => source && source.enabled)
  if (enabled.length === 0) return null
  const want = String(provider || '').trim().toLowerCase()
  if (want !== '') {
    for (const source of enabled) {
      const ids = Array.isArray(source.providerIds) ? source.providerIds : []
      for (const id of ids) {
        if (String(id).trim().toLowerCase() === want) return source
      }
    }
  }
  if (enabled.length === 1) return enabled[0]
  return null
}

/**
 * 一个来源「在账本里用什么币种当作用户配置的币种」。
 *
 * ⚠️ 这是**显示币种**，不是余额币种 —— 两者必须分开：
 *   · 显示币种 = `config.currency`（默认 `¥`，用户填的符号）→ 只用来拼 scope 键；
 *   · 余额币种 = 适配器/接口给的 `CNY`/`USD` → 记进账本、给界面。
 * 早期实现只用「显示币种」去反查 scope，可 `fetchBalance` 会把结果里的币种
 * 改写成适配器币种（`¥` → `CNY`），于是 scope 后缀永远对不上，
 * `resolveForProvider` 一律返回 `warming` —— 汇总行的余额恒为 `—`，
 * 即使来源、密钥、取数全都正常（2026-10-06 用户实测的正是这个）。
 */
export function displayCurrencyOf(config, source) {
  const adapter = adapterOf(source && source.adapter)
  return String((config && config.currency) || adapter.currency || 'CNY').toUpperCase()
}

/** 汇总行/明细面板要的「余额段」。 */
export function balanceView(state) {
  if (!state) return { known: false, reason: 'warming' }
  if (state.kind === 'quota') {
    return {
      known: false,
      kind: 'quota',
      sourceLabel: state.sourceLabel || '',
      provider: state.provider || '',
      windows: state.windows || [],
      at: state.at,
      reason: 'quota',
      note: state.note,
    }
  }
  if (!state.ok) {
    return {
      known: false,
      reason: state.reason,
      reasonText: state.reasonText || failureText(state.reason),
      sourceLabel: state.sourceLabel || '',
      provider: state.provider || '',
      at: state.at,
      raw: state.raw,
    }
  }
  return {
    known: true,
    kind: 'balance',
    amount: state.amount,
    currency: state.currency,
    sourceLabel: state.sourceLabel || '',
    provider: state.provider || '',
    at: state.at,
    raw: state.raw,
    /* 「额度接口不可用 → 已改查现金余额」这类说明，界面照实显示（见 balance.js 的 NOTE_NO_CODING_PLAN）。 */
    note: state.note,
  }
}

/**
 * 建一个余额管理器。
 *
 * @param deps `{fetch, fs, credentials, credentialsProvider, now, ledgerFile, logger, schedule, cancel, sleep}`
 *   `schedule(fn, ms)` 返回一个可取消的句柄（默认用 setTimeout）。
 *
 * ⚠️ **凭据服务必须「用的时候再取」**（`credentialsProvider`），不能只在建管理器的那一刻取一次。
 * 2026-10-06 的真实 bug：保存设置会让本插件所在的条目重载，重载窗口里
 * `ctx.get('credentials')` 取不到 → 管理器把 `null` 存了一辈子 → 此后每次取余额都走
 * `no-key` 分支，界面显示「余额 —」，而且**看起来像用户没配密钥**（文案误导）；
 * 手动停用/启用一次插件（= 重建管理器）才会恢复。见 AGENTS §14。
 */
export function createBalanceManager(deps) {
  const fetchImpl = deps.fetch
  const fs = deps.fs
  const credentials = deps.credentials || null
  /** 每次用凭据时**重新取一次服务**；没有 provider 时退回建管理器时那个引用（测试与旧调用方）。 */
  const credentialsProvider = typeof deps.credentialsProvider === 'function'
    ? deps.credentialsProvider
    : () => credentials
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const ledgerFile = deps.ledgerFile
  const logger = deps.logger || { warn() {} }
  const schedule = typeof deps.schedule === 'function'
    ? deps.schedule
    : (fn, ms) => setTimeout(fn, ms)
  const cancel = typeof deps.cancel === 'function' ? deps.cancel : (handle) => clearTimeout(handle)
  const sleep = typeof deps.sleep === 'function'
    ? deps.sleep
    : (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

  let ledger = emptyLedger()
  let ledgerRecovered = null
  /** 最近一次取数结果：scope → {ok, kind, amount?, windows?, reason?, at, seq, ...} */
  const last = new Map()
  /**
   * 取数的**单调序号**（每次 fetchOne 自增）。
   *
   * ⚠️ 为什么不能只用 `at` 排序：同一毫秒内跑两轮（测试里就是）会拿到相同的 `at`，
   * 「谁更新」就分不出来 —— `resolveForProvider` 会挑中那条**旧的失败**。
   * 序号与时钟无关，永远能比出先后。
   */
  let fetchSeq = 0
  let timer = null
  let started = false
  let saveTimer = null
  let dirty = false
  let lastError = ''
  /** 最近一次「拿到凭据服务了吗」（供 `/state.json` 如实上报；`null` = 还没试过）。 */
  let credentialsAvailable = null
  /** 「凭据服务缺失」后的补试句柄（有界：只补一次，见 scheduleCredentialsRetry）。 */
  let credentialsRetryTimer = null
  /**
   * 最近一次「观测入账」的结果：`{ok, day, amount}` 或 `{ok:false, reason, detail?}`。
   *
   * 为什么要单独记：观测失败以前**只写一行 logger.warn**，于是「余额显示正常、
   * 账本里却一条观测都没有、今日真实花费恒为 ¥0.00」这种故障在界面上完全看不见
   * （2026-10-06 花了很久才定位）。现在它会被 `/state.json` 报给客户端。
   */
  let lastObservation = null

  function load() {
    const loaded = loadLedgerSync(fs, ledgerFile, emptyLedger)
    ledger = isLedgerShape(loaded.ledger) ? loaded.ledger : emptyLedger()
    ledgerRecovered = loaded.recovered
      ? { backupPath: loaded.backupPath, error: loaded.error }
      : null
    if (ledgerRecovered) logger.warn('turn-cost: ledger 损坏已备份重建：%s', String(ledgerRecovered.error))
    return ledger
  }

  /** 去抖 ≥2s 的原子写（照 §10.4）。 */
  function markDirty() {
    dirty = true
    if (saveTimer !== null) return
    saveTimer = schedule(() => {
      saveTimer = null
      flush()
    }, 2000)
  }

  function flush() {
    if (!dirty) return
    dirty = false
    try {
      saveLedgerSync(fs, ledgerFile, ledger)
    } catch (err) {
      lastError = err && err.message ? err.message : String(err)
      logger.warn('turn-cost: ledger 写入失败：%s', lastError)
    }
  }

  /** 有多少次「服务缺失」的重试、间隔多久（合计约 1.5 秒 —— 覆盖重载窗口）。 */
  const CREDENTIALS_RETRIES = 3
  const CREDENTIALS_RETRY_MS = 500

  /**
   * 现在能拿到凭据服务吗？**每次调用都重新取**，拿不到就有界重试（合计约 1.5s）。
   *
   * 为什么不能缓存：`ctx.get('credentials')` 在「插件/条目重载」「服务晚一步注册」的
   * 窗口里会返回 null（AGENTS §4 第 5 层 + §14）。缓存 null 就是永久故障。
   * 拿不到**不是错误**（不打日志刷屏），只是这一轮取余额会被跳过，并由
   * `no-credentials-service` 如实上报 —— 下一轮（或补试）会自己好。
   */
  async function currentCredentials() {
    for (let attempt = 0; attempt <= CREDENTIALS_RETRIES; attempt++) {
      let candidate = null
      try { candidate = credentialsProvider() } catch (err) { candidate = null }
      if (candidate && typeof candidate.resolve === 'function') {
        credentialsAvailable = true
        return candidate
      }
      if (attempt < CREDENTIALS_RETRIES) await sleep(CREDENTIALS_RETRY_MS)
    }
    credentialsAvailable = false
    return null
  }

  /** 解析一个凭据名（拿不到服务时返回空串；调用方用 `currentCredentials` 区分原因）。 */
  async function resolveKey(service, ref) {
    const resolved = await resolveCredentialValue(service, ref)
    return resolved.value
  }

  /**
   * 一轮里出现过「凭据服务缺失」时，安排一次**补试**（只补一次，别变成忙等）。
   * 理由：定时刷新默认 300 秒一次，用户不该为了一个 1 秒的重载窗口等五分钟。
   */
  function scheduleCredentialsRetry(config) {
    if (credentialsRetryTimer !== null || !started) return
    credentialsRetryTimer = schedule(async () => {
      credentialsRetryTimer = null
      try { await refreshAll(config) } catch (err) { /* 失败就等下一轮定时刷新 */ }
    }, 15 * 1000)
  }

  /**
   * 取一次某个来源的余额/额度，并把成功取到的余额记进账本。
   * @returns 取数结果
   */
  async function fetchOne(source, options = {}) {
    const config = options.config || {}
    const adapter = adapterOf(source.adapter)
    const at = now()
    fetchSeq += 1
    const seq = fetchSeq
    /** 需要密钥的适配器才去要凭据服务（`none` / 免密钥的适配器不碰它）。 */
    const needsKey = adapter.kind !== 'none' && adapter.credentialRef !== ''
    const service = needsKey ? await currentCredentials() : null
    const key = needsKey && service !== null ? await resolveKey(service, source.credentialRef) : ''
    const fingerprint = fingerprintOf(key)
    const currency = String(config.currency || adapter.currency || 'CNY').toUpperCase()
    const scope = scopeKeyOf(source.adapter || 'none', fingerprint, currency)
    const base = {
      scope,
      adapter: source.adapter || 'none',
      sourceLabel: source.label || adapter.label || '',
      provider: Array.isArray(source.providerIds) && source.providerIds.length ? source.providerIds[0] : '',
      at,
      /** 单调递增的取数序号（见 fetchSeq 的注释：同一毫秒内也能比出先后）。 */
      seq,
      /** 取数时用的**显示币种**（见 displayCurrencyOf 的注释：它和结果里的币种可能不同）。 */
      displayCurrency: currency,
    }

    if (adapter.kind === 'none') {
      const result = { ...base, ok: false, kind: 'none', reason: 'no-balance-api', reasonText: failureText('no-balance-api'), raw: null }
      last.set(scope, result)
      return result
    }
    /**
     * ⚠️ **凭据服务拿不到 ≠ 用户没配密钥**：两者都表现为「余额 —」，
     * 但前者是插件自己的问题（且会自动重试），报成「没有配置密钥」会把用户引到错的方向
     * （2026-10-06 实测：密钥明明在，界面上却一直说没配密钥）。
     */
    if (needsKey && service === null) {
      const result = {
        ...base,
        ok: false,
        kind: adapter.kind,
        reason: 'no-credentials-service',
        reasonText: failureText('no-credentials-service'),
        raw: null,
      }
      last.set(scope, result)
      scheduleCredentialsRetry(config)
      return result
    }
    if (key === '' && adapter.credentialRef !== '') {
      const result = { ...base, ok: false, kind: adapter.kind, reason: 'no-key', reasonText: failureText('no-key'), raw: null }
      last.set(scope, result)
      return result
    }

    const got = await fetchBalance({ fetch: fetchImpl }, {
      adapter: source.adapter,
      key,
      baseUrl: source.baseUrl,
      /* ⚠️ **只传用户自己填的显示名**（不兜底适配器 label）：回退路径要靠「有没有显示名」
         来决定是否换成「…（余额）」（见 balance.js 的 explicitLabel）。 */
      label: source.label,
      provider: base.provider,
      /* 显示币种只作回显（界面文案）；余额币种一律取适配器的 ISO 码。 */
      displayCurrency: currency,
      timeoutMs: config.balanceTimeoutMs,
    })

    /**
     * 「这个账号没有 Coding Plan」不是服务端故障，是**这把 key 的账号类型**问题 ——
     * 照实说，并且给出去哪改（2026-10-06 之前这里会显示成「服务端错误（5xx）」，误导）。
     */
    const reason = !got.ok && isNoCodingPlanError(got.reason, got.detail) ? 'no-coding-plan' : got.reason
    const result = {
      ...base,
      ...got,
      reason,
      reasonText: got.ok ? '' : failureText(reason),
      /* ⚠️ 取数结果里的 `label` 优先：额度接口回退到余额接口时它会被换成「…（余额）」，
         否则界面会出现「智谱 GLM Coding Plan（额度）：¥1.90」这种自相矛盾的组合。 */
      sourceLabel: source.label || got.label || base.sourceLabel,
    }
    last.set(scope, result)

    if (got.ok && got.kind === 'balance') {
      try {
        const written = observeBalance(ledger, {
          at,
          balance: got.amount,
          /**
           * ⚠️ **必须用结果里的余额币种（3 位 ISO 码），不能传 `currency`** ——
           * 那是**显示币种**（用户填的符号，默认 `¥`）。账本的 `observeBalance` 会校验
           * `/^[A-Z]{3}$/`，传 `¥` 直接抛「余额币种无效」，整次观测被吞掉：
           * 界面上余额照常显示，账本里 `firstAt`/`lastAt` 永远是 null、
           * 「今日真实花费」永远 ¥0.00（2026-10-06 用户实测的第四层 bug）。
           */
          currency: got.currency || currency,
          scope,
          provider: base.provider,
        }, { tzOffset: Number(config.tzOffset ?? 8) })
        lastObservation = written.ok
          ? { ok: true, day: written.day, amount: got.amount }
          : { ok: false, reason: written.reason || 'rejected', day: written.day }
        if (written.ok) markDirty()
      } catch (err) {
        lastError = err && err.message ? err.message : String(err)
        lastObservation = { ok: false, reason: 'threw', detail: lastError }
        logger.warn('turn-cost: 观测入账失败：%s', lastError)
      }
    }
    return result
  }

  /** 按配置取一轮（所有启用的来源）。 */
  async function refreshAll(config, options = {}) {
    const sources = (Array.isArray(config && config.balanceSources) ? config.balanceSources : [])
      .filter((source) => source && source.enabled)
    const results = []
    for (const source of sources) {
      /* 单个来源失败不影响其它来源（§10.1 的隔离要求）。 */
      try {
        results.push(await fetchOne(source, { config }))
      } catch (err) {
        logger.warn('turn-cost: 取余额异常（%s）：%s', String(source.adapter), err && err.message ? err.message : String(err))
      }
    }
    return results
  }

  function scheduleNext(config) {
    if (!started) return
    const seconds = Math.max(60, Math.min(3600, Number(config && config.balanceRefreshSeconds) || 300))
    if (timer !== null) { cancel(timer); timer = null }
    timer = schedule(async () => {
      timer = null
      try {
        await refreshAll(config)
      } catch (err) {
        logger.warn('turn-cost: 定时刷新失败：%s', err && err.message ? err.message : String(err))
      }
      scheduleNext(config)
    }, seconds * 1000)
  }

  return {
    load,
    refreshAll,
    fetchOne,
    markDirty,
    flush,
    start(config) {
      started = true
      scheduleNext(config)
    },
    stop() {
      started = false
      if (timer !== null) { cancel(timer); timer = null }
      if (saveTimer !== null) { cancel(saveTimer); saveTimer = null }
      if (credentialsRetryTimer !== null) { cancel(credentialsRetryTimer); credentialsRetryTimer = null }
      flush()
    },
    dispose() {
      this.stop()
    },
    getLedger() { return ledger },
    getBook(scope) { return ledger.books ? ledger.books[scope] : undefined },
    lastResult(scope) { return last.get(scope) || null },
    allLastResults() { return [...last.values()] },
    recovered() { return ledgerRecovered },
    lastError() { return lastError },
    /** 最近一次观测入账的结果（供 /state.json 如实上报，见 lastObservation 的注释）。 */
    lastObservation() { return lastObservation },
    /**
     * 最近一次「拿得到宿主的凭据服务吗」。`null` = 还没试过。
     *
     * 单独立一个可观测出口的理由（照 AGENTS §12 的方法论）：`no-key` 与
     * `no-credentials-service` 在界面上都是「余额 —」，只有这个字段能区分
     * 「用户没配」和「插件没拿到服务」。
     */
    credentialsAvailable() { return credentialsAvailable },
    bytes() { return ledgerBytesSync(fs, ledgerFile) },
    /** 供 /refresh 使用：立刻刷一次并落盘。 */
    async refreshNow(config) {
      const results = await refreshAll(config)
      flush()
      return results
    },
    /**
     * 当前会话该显示哪个 scope 的余额（按路由匹配）。
     *
     * ⚠️ **必须取「最近一次」的结果，不能取第一个匹配的**：
     * 同一把来源在不同时刻可能产生**不同 scope** 的结果 —— 例如凭据服务晚就绪时是
     * `adapter|nokey|¥`、拿到密钥后变成 `adapter|<指纹>|¥`（2026-10-06 实测的正是这条链）。
     * 取第一个匹配的会把那条**旧的失败**一直显示在汇总行上，即使后面已经取到了余额。
     *
     * @returns `{scope, state}|{scope:null, state:null, reason}`
     */
    resolveForProvider(config, provider) {
      const source = pickSource(config && config.balanceSources, provider)
      if (source === null) {
        return { scope: null, state: null, reason: 'no-source' }
      }
      const currency = displayCurrencyOf(config, source)
      /* 指纹要跟取数时一致：这里没有 key，所以退化成"在最近结果里按 adapter 找"。
         比对 `displayCurrency` 而不是结果币种 —— 结果币种会被适配器改写成 CNY/USD。 */
      let found = null
      for (const [, state] of last.entries()) {
        if (state.adapter !== (source.adapter || 'none')) continue
        const stateCurrency = String(state.displayCurrency || state.currency || '').toUpperCase()
        if (stateCurrency !== currency) continue
        if (found === null) { found = state; continue }
        /* 先比单调序号（同一毫秒也能分先后），序号缺失的老结果再退回比 `at`。 */
        const newer = Number.isFinite(Number(state.seq)) && Number.isFinite(Number(found.seq))
          ? Number(state.seq) > Number(found.seq)
          : Number(state.at) > Number(found.at)
        if (newer) found = state
      }
      if (found !== null) {
        const scope = typeof found.scope === 'string' && found.scope !== ''
          ? found.scope
          : scopeKeyOf(source.adapter || 'none', '', currency)
        return { scope, state: found, source }
      }
      return { scope: null, state: null, reason: 'warming', source }
    },
  }
}

/** 探活（/test-connection 用；不写账本、不改配置）。 */
export async function testConnection(deps, input) {
  const adapter = adapterOf(input && input.adapter)
  const key = String((input && input.key) || '')
  if (adapter.kind === 'none') {
    return {
      ok: false,
      reason: 'no-balance-api',
      reasonText: failureText('no-balance-api'),
      probe: await probeConnection({ fetch: deps.fetch }, {
        baseUrl: input.baseUrl,
        key,
        timeoutMs: input.timeoutMs,
      }),
    }
  }
  const result = await fetchBalance({ fetch: deps.fetch }, {
    adapter: input.adapter,
    key,
    baseUrl: input.baseUrl,
    label: input.label,
    timeoutMs: input.timeoutMs,
    /* 设置页的草稿配置里那个「显示币种」——只用于把金额拼成人看的文本。 */
    displayCurrency: input.currency,
  })
  /* 币种兜底：**显示币种优先**（界面文案用），其次适配器的 ISO 码。
     漏掉兜底就会把 undefined 拼进金额文本 —— 用户实测过「12.85undefined」。 */
  const currency = result.displayCurrency || input.currency || result.currency || adapter.currency || 'CNY'
  /* 「没有 coding plan」要单独说清楚 —— 它过去被归成「服务端错误（5xx）」（2026-10-06 用户实测）。 */
  const reason = !result.ok && isNoCodingPlanError(result.reason, result.detail) ? 'no-coding-plan' : result.reason
  return { ...result, currency, reason, reasonText: result.ok ? '' : failureText(reason) }
}
