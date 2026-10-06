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
import { fetchBalance, adapterOf, failureText, probeConnection } from './balance.js'
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
  }
}

/**
 * 建一个余额管理器。
 *
 * @param deps `{fetch, fs, credentials, now, ledgerFile, logger, schedule, cancel}` 
 *   `schedule(fn, ms)` 返回一个可取消的句柄（默认用 setTimeout）
 */
export function createBalanceManager(deps) {
  const fetchImpl = deps.fetch
  const fs = deps.fs
  const credentials = deps.credentials || null
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const ledgerFile = deps.ledgerFile
  const logger = deps.logger || { warn() {} }
  const schedule = typeof deps.schedule === 'function'
    ? deps.schedule
    : (fn, ms) => setTimeout(fn, ms)
  const cancel = typeof deps.cancel === 'function' ? deps.cancel : (handle) => clearTimeout(handle)

  let ledger = emptyLedger()
  let ledgerRecovered = null
  /** 最近一次取数结果：scope → {ok, kind, amount?, windows?, reason?, at, ...} */
  const last = new Map()
  let timer = null
  let started = false
  let saveTimer = null
  let dirty = false
  let lastError = ''
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

  async function resolveKey(ref) {
    const resolved = await resolveCredentialValue(credentials, ref)
    return resolved.value
  }

  /**
   * 取一次某个来源的余额/额度，并把成功取到的余额记进账本。
   * @returns 取数结果
   */
  async function fetchOne(source, options = {}) {
    const config = options.config || {}
    const adapter = adapterOf(source.adapter)
    const key = await resolveKey(source.credentialRef)
    const at = now()
    const fingerprint = fingerprintOf(key)
    const currency = String(config.currency || adapter.currency || 'CNY').toUpperCase()
    const scope = scopeKeyOf(source.adapter || 'none', fingerprint, currency)
    const base = {
      scope,
      adapter: source.adapter || 'none',
      sourceLabel: source.label || adapter.label || '',
      provider: Array.isArray(source.providerIds) && source.providerIds.length ? source.providerIds[0] : '',
      at,
      /** 取数时用的**显示币种**（见 displayCurrencyOf 的注释：它和结果里的币种可能不同）。 */
      displayCurrency: currency,
    }

    if (adapter.kind === 'none') {
      const result = { ...base, ok: false, kind: 'none', reason: 'no-balance-api', reasonText: failureText('no-balance-api'), raw: null }
      last.set(scope, result)
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
      label: source.label || adapter.label,
      provider: base.provider,
      /* 显示币种只作回显（界面文案）；余额币种一律取适配器的 ISO 码。 */
      displayCurrency: currency,
      timeoutMs: config.balanceTimeoutMs,
    })

    const result = { ...base, ...got, reasonText: got.ok ? '' : failureText(got.reason) }
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
    bytes() { return ledgerBytesSync(fs, ledgerFile) },
    /** 供 /refresh 使用：立刻刷一次并落盘。 */
    async refreshNow(config) {
      const results = await refreshAll(config)
      flush()
      return results
    },
    /**
     * 当前会话该显示哪个 scope 的余额（按路由匹配）。
     * @returns `{scope, state}|{scope:null, state:null, reason}`
     */
    resolveForProvider(config, provider) {
      const source = pickSource(config && config.balanceSources, provider)
      if (source === null) {
        return { scope: null, state: null, reason: 'no-source' }
      }
      const adapter = adapterOf(source.adapter)
      const currency = displayCurrencyOf(config, source)
      /* 指纹要跟取数时一致：这里没有 key，所以退化成"在最近结果里按 adapter 找"。
         先按「缓存结果自带的 scope」精确找（同 adapter 多把密钥时唯一可靠），
         再按取数时的显示币种兜底；两次都比对 `displayCurrency` 而不是结果币种
         —— 结果币种会被适配器改写成 CNY/USD，拿它比对会永远匹配不上。 */
      for (const [, state] of last.entries()) {
        if (state.adapter !== (source.adapter || 'none')) continue
        const stateCurrency = String(state.displayCurrency || state.currency || '').toUpperCase()
        if (stateCurrency !== currency) continue
        const scope = typeof state.scope === 'string' && state.scope !== ''
          ? state.scope
          : scopeKeyOf(source.adapter || 'none', '', currency)
        return { scope, state, source }
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
  return { ...result, currency, reasonText: result.ok ? '' : failureText(result.reason) }
}
