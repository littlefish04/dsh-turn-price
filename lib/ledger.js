/**
 * dsh-turn-cost — 真实日账（余额观测差值法）+ 每轮估算账
 *
 * ── 设计要点（照 IMPLEMENTATION-PROMPT §10.2 / §10.4，参考实现 dsh-whale-widget
 *    的 `lib/accounting.mjs`，MIT，语义与坑都核对过）────────────────────────────
 *
 * 1. **金额一律用整数微单位**（×1e8）算，避免浮点误差；对外的金额再除回来。
 * 2. **日归属用插件的 `tzOffset`**（默认 +8），与轮尾计费时刻**同一套时区逻辑** ——
 *    不要用宿主本地时区，否则跨零点会把消费记到错的一天。
 * 3. 余额**下降**记 `debitUnits`；余额**上升**记 `creditUnits` 并标 `needsReview`
 *    （差额里很可能混着充值）。
 * 4. 乱序/重复样本（`at <= lastAt`，含**晚到的昨日样本**）一律忽略。
 * 5. **不完整判定 `PARTIAL_GAP_MS = 10 分钟`**：某天首个观测距当天 00:00 > 10min，
 *    或（对**已经过去**的日子）次日 00:00 距最后一个观测 > 10min → 该天「数据不完整」。
 *    **今天永远算「观测中」**，不参与不完整判定（app 不会在 00:00 就开着）。
 * 6. **留空 vs 0**：没有观测的日子在账里**没有这一行** → UI 显示 `—`；
 *    有观测且当天净消费为 0 → `¥0.00`。两者必须能一眼区分（用户专门提过）。
 * 7. **保留期裁剪绝不动当月与今天**；裁剪幂等。
 * 8. 本模块是**纯函数**（除 open/save 两个文件函数）：便于离线单测。
 *    它自己不改 `ledger` 以外的东西，也不读时钟（`now` 由调用方传入）。
 *
 * 唯一例外：`ledgerPathOf()` 会在 `DSH_HOME` 缺失时读一次 `os.homedir()` 兜底
 * （见该函数注释里的 bug #4）。那是**路径解析**，不碰账本数据，也不影响单测。
 */
import * as nodeOs from 'node:os'

export const LEDGER_VERSION = 1

/** 金额的整数微单位刻度（1e8），与参考实现一致。 */
export const SCALE = 100000000

/** 不完整判定的观测缺口阈值：10 分钟。 */
export const PARTIAL_GAP_MS = 10 * 60 * 1000

/** 一个 `correctionLog` 最多留多少条（参考实现同值）。 */
export const CORRECTION_LOG_LIMIT = 50

/** 估算账每天最多留多少轮（防止单日异常轮数把文件撑爆）。 */
export const MAX_TURNS_PER_DAY = 5000

/* ─────────────────────────── 金额（整数微单位）─────────────────────────── */

/** 金额 → 整数微单位；非法或超出安全整数范围就抛（宁可报错也不写坏账）。 */
export function moneyUnits(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error('金额无效')
  const units = Math.round(n * SCALE)
  if (!Number.isSafeInteger(units)) throw new Error('金额超出可记账范围')
  return units
}

/** 整数微单位 → 金额。 */
export function unitsToMoney(units) {
  const n = Number(units)
  if (!Number.isSafeInteger(n)) throw new Error('微单位超出可记账范围')
  return n / SCALE
}

/** 一串金额求和（用微单位避免浮点误差）。 */
export function sumMoney(values) {
  let units = 0
  for (const value of values) {
    units += moneyUnits(value)
    if (!Number.isSafeInteger(units)) throw new Error('金额合计超出可记账范围')
  }
  return unitsToMoney(units)
}

/* ───────────────────────────── 日期/时区 ───────────────────────────── */

function pad2(n) {
  return (n < 10 ? '0' : '') + n
}

/** 校验 `YYYY-MM-DD`。 */
export function isDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/** 时刻（epoch 毫秒）→ 该时区下的 `YYYY-MM-DD`。 */
export function dayOf(time, tzOffset) {
  const ms = Number(time)
  if (!Number.isFinite(ms)) throw new Error('无效的观测时间')
  const d = new Date(ms + Number(tzOffset) * 3600000)
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
}

/** `YYYY-MM-DD` 在该时区下的当天 00:00（epoch 毫秒）。 */
export function dayStartMs(day, tzOffset) {
  if (!isDay(day)) throw new Error('无效的日期：' + String(day))
  const [y, m, d] = day.split('-').map((part) => parseInt(part, 10))
  return Date.UTC(y, m - 1, d) - Number(tzOffset) * 3600000
}

/** 日期加减天数。 */
export function dayOffset(day, days, tzOffset) {
  return dayOf(dayStartMs(day, tzOffset) + Number(days) * 86400000, tzOffset)
}

/** 当月天数（用于把 `monthStartDay` 钳制到合法范围）。 */
export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * 按 `monthStartDay`（1–31）算出 `day` 所属「记账月」的起始日。
 *
 * 语义：记账月从每月的第 `monthStartDay` 天开始；该日**之前**属于上一个月。
 * `day < 当月的起始日` ⇒ 退回上一个月的起始日。
 * 起始日超过当月天数时**按当月天数钳制**（如 31 在 2 月按 28/29）。
 */
export function monthStartOf(day, monthStartDay, tzOffset) {
  if (!isDay(day)) throw new Error('无效的日期：' + String(day))
  const want = Math.max(1, Math.min(31, Math.round(Number(monthStartDay) || 1)))
  const year = parseInt(day.slice(0, 4), 10)
  const month = parseInt(day.slice(5, 7), 10)
  const clamp = (y, m) => Math.min(want, daysInMonth(y, m))
  const thisStart = year + '-' + pad2(month) + '-' + pad2(clamp(year, month))
  if (day >= thisStart) return thisStart
  const prevMonth = month === 1 ? 12 : month - 1
  const prevYear = month === 1 ? year - 1 : year
  return prevYear + '-' + pad2(prevMonth) + '-' + pad2(clamp(prevYear, prevMonth))
}

/** 记账月的结束日（= 下一个记账月起始日的**前一天**）。 */
export function monthEndOf(day, monthStartDay, tzOffset) {
  const start = monthStartOf(day, monthStartDay, tzOffset)
  const year = parseInt(start.slice(0, 4), 10)
  const month = parseInt(start.slice(5, 7), 10)
  /* 往后跳「当月天数 + 1 天」必定落在下一个记账月的起始日之后，
     再求它的记账月起点，就是下一个起始日（不必处理跨年，monthStartOf 会处理）。 */
  const probe = dayOffset(start, daysInMonth(year, month) + 1, tzOffset)
  return dayOffset(monthStartOf(probe, monthStartDay, tzOffset), -1, tzOffset)
}

/* ─────────────────────────── 账本容器 ─────────────────────────── */

/** 空账本。 */
export function emptyLedger() {
  return { version: LEDGER_VERSION, active: '', books: {}, updatedAt: 0 }
}

/**
 * 启动时的校验：`JSON.parse` 失败或版本不认识 → **把原文件改名备份**后重建，
 * **绝不能因此让宿主起不来**（IMPLEMENTATION-PROMPT §10.4）。
 */
export function isLedgerShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (value.version !== LEDGER_VERSION) return false
  if (typeof value.active !== 'string') return false
  if (!value.books || typeof value.books !== 'object' || Array.isArray(value.books)) return false
  return true
}

/** 账户分本键：`<adapter>|<sha256(key)前 8 位>|<currency>`（换 key 就换一本账）。 */
export function scopeKeyOf(adapter, fingerprint, currency) {
  const a = String(adapter || 'none')
  const f = String(fingerprint || 'nokey').slice(0, 8).toLowerCase() || 'nokey'
  const c = String(currency || 'CNY').toUpperCase()
  return a + '|' + f + '|' + c
}

function ensureBook(ledger, scope, provider, currency) {
  let book = ledger.books[scope]
  if (book === undefined) {
    book = { scope, provider: String(provider || ''), currency: String(currency || 'CNY').toUpperCase(), days: {}, lastAt: 0 }
    ledger.books[scope] = book
  }
  return book
}

/**
 * 一个「微单位」字段是否**真的有值**。
 *
 * ⚠️ 存在的唯一理由：`Number(null)` 是 `0` 且 `Number.isFinite(0)` 是 `true`，
 * 于是「还没观测过（null）」会被误判成「观测到 0 元」。单位字段在
 * `recordTurn` 建行时就是 null，所以这个区分是必需的（2026-10-06 的真实 bug）。
 */
function hasUnit(value) {
  if (value === null || value === undefined || value === '') return false
  return Number.isFinite(Number(value))
}

/**
 * 这一天的行里**有没有真实观测**（余额取数成功过）。
 *
 * 只有「有估算轮次」的行（`recordTurn` 建的、单位字段是 null）**不算观测** ——
 * 决策 #7：没有观测的日子必须留空（—），**与「消费 0 元」严格区分**。
 */
export function hasObservation(row) {
  return !!row && hasUnit(row.lastUnits) && hasUnit(row.openingUnits)
}

export function bookOf(ledger, scope) {
  return ledger && ledger.books ? ledger.books[scope] : undefined
}

/* ─────────────────────── 观测（真实日账写入）─────────────────────── */

/**
 * 记一次余额观测。
 *
 * @param ledger 调用方独占的账本对象（**就地修改**）
 * @param snapshot `{at, balance, currency, scope, provider}`
 * @param options `{tzOffset}`
 * @returns {{ok:boolean, reason?:string, day?, row?, book?}}
 *          `reason: 'duplicate'` 表示乱序/重复样本被忽略（不是错误）
 */
export function observeBalance(ledger, snapshot, options = {}) {
  const tzOffset = Number(options.tzOffset ?? 8)
  const at = Number(snapshot && snapshot.at !== undefined ? snapshot.at : NaN)
  if (!Number.isFinite(at)) throw new Error('无效的观测时间')
  const units = moneyUnits(snapshot.balance)
  if (units < 0) throw new Error('余额不能为负数')
  const currency = String(snapshot.currency || 'CNY').toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('余额币种无效')
  const scope = String(snapshot.scope || 'default')
  if (scope === '' || scope.length > 120) throw new Error('账户标识无效')
  const day = dayOf(at, tzOffset)

  const book = ensureBook(ledger, scope, snapshot.provider, currency)
  /* 乱序/重复样本忽略：含**晚到的昨日样本**（它们的 at 必然 <= lastAt）。 */
  const lastAt = Number(book.lastAt) || 0
  if (lastAt > 0 && at <= lastAt) return { ok: false, reason: 'duplicate', day, book }

  let row = book.days[day]
  /**
   * 当天行是否已经有过**观测**。
   *
   * ⚠️ 必须显式判 null/undefined —— **`Number(null)` 是 0、`Number.isFinite(0)` 是 true**，
   * 用 `Number.isFinite(Number(row.lastUnits))` 判会把「还没观测过」误判成「观测过 0 元」。
   * 判据统一走 `hasObservation()`（本文件唯一的「有没有观测」口径）。
   */
  const observed = hasObservation(row)
  if (!observed) {
    if (row === undefined) {
      row = {
        day,
        firstAt: at,
        lastAt: at,
        openingUnits: units,
        lastUnits: units,
        debitUnits: 0,
        creditUnits: 0,
        revision: 0,
        correction: null,
        turns: [],
      }
      book.days[day] = row
    } else {
      /* ⚠️ 走到这里说明当天**已经有估算轮次**（`recordTurn` 建过行，
         `openingUnits`/`lastUnits` 是 null），但还没有任何观测。
         晚期实现直接做 `row.lastUnits - units` = `null - 数字` = **NaN**，
         于是整天的观测被静默吞掉（NaN 落盘成 null，读回来又被 Number(null) 变成 0）——
         症状就是「今日真实花费」恒为 ¥0.00、账本里 firstAt/lastAt 一直是 null。
         正确语义：**当天第一次观测就是当天基线**，估算行与观测互不覆盖。 */
      row.firstAt = at
      row.lastAt = at
      row.openingUnits = units
      row.lastUnits = units
      if (!Array.isArray(row.turns)) row.turns = []
    }
  } else {
    const delta = row.lastUnits - units
    if (delta > 0) row.debitUnits += delta
    else if (delta < 0) row.creditUnits += -delta
    row.lastUnits = units
    row.lastAt = at
  }
  book.lastAt = at
  book.provider = String(snapshot.provider || book.provider || '')
  ledger.active = scope
  ledger.updatedAt = at
  return { ok: true, day, row, book, duplicate: false }
}

/**
 * 某天观测到的净消费（微单位）。
 *
 * ⚠️ 用 `期初 − 期末`，**不是**「逐次下降之和」（`debitUnits`）：一旦当天发生过充值，
 * 两者就不相等 —— 逐次下降之和只统计了下降的那些步，会漏掉充值之后继续消费的部分
 * （或反过来把净额算错）。参考实现（dsh-whale-widget `accounting.mjs` 的
 * `observedAmount`）用的也是「期初 − 期末」。
 *
 * 有手工校正时以校正值为准（校正 = 用户核对了充值之后的真实消费）。
 */
export function observedDebitUnits(row) {
  if (!row) return 0
  const c = row.correction
  if (c) return c.amountUnits
  /* ⚠️ 没有观测的行（只有估算轮次）**不是**「消费 0 元」：
     旧实现走到 `Number(null) - Number(null)` = 0，会让「今日/本月真实消费」显示成
     `¥0.00`，违反决策 #7（没有观测要留空，且必须与 0 元区分）。这里返回 0 只表示
     「这一天没有可用于求和的观测」，界面上由 `daySummary → null` / `missing` 表达留空。 */
  if (!hasObservation(row)) return 0
  const opening = Number(row.openingUnits)
  const last = Number(row.lastUnits)
  if (!Number.isFinite(opening) || !Number.isFinite(last)) return Number(row.debitUnits) || 0
  return opening - last
}

/** 是否「有待核对的余额上升」（充值可能混在里面）。 */
export function needsReview(row) {
  if (!row) return false
  const c = row.correction
  return row.creditUnits > (c ? c.creditUnits : 0)
}

/**
 * 某天的「不完整」判定 + 缺口明细。
 *
 * 判据照参考实现（dsh-whale-widget `lib/accounting.mjs` 的 `partialDayInfo`）：
 *   · `leadingGapMs`  = 该天首个观测 − 当天 00:00；
 *   · `trailingGapMs` = 当天 24:00 − 该天**最后一个观测**（`row.lastAt`），且只在该天
 *     已经过去时才算。
 *   任一缺口 > 10 分钟 ⇒ 该天「数据不完整」。
 *
 * ⚠️ 关于 `row.lastAt`：同一天的观测都写同一行，所以「该天最后一个观测」就是
 * `row.lastAt` —— **不要**去扫次日行（我一开始那么写，结果把 3-02 23:50 的正常日
 * 算成"被 3-03 00:11 补上了"，反而漏判）。行的时间戳落在哪天，就归哪天的行。
 *
 * 今天是例外：`inProgress: true` 且**不参与**不完整判定（app 不会在 00:00 就开着）。
 * ⚠️ **这是有意的，不要"修"**（2026-10-06 与用户确认过）：当天第一次观测就是当天基线，
 * 所以重启后「今日」会显示 `¥0.00` 直到下一次余额下降 —— 这是**正确语义**
 * （从基线起算确实还没花钱），用户明确表示这个 `¥0.00` 是正常的、不要改。
 */
export function partialDayInfo(day, row, now, tzOffset) {
  const offset = Number(tzOffset ?? 8)
  const start = dayStartMs(day, offset)
  const end = start + 86400000
  const at = Number(now)
  const first = row ? Number(row.firstAt) : NaN
  const last = row ? Number(row.lastAt) : NaN
  const inProgress = Number.isFinite(at) && at >= start && at < end
  if (!row || !Number.isFinite(first) || !Number.isFinite(last)) {
    return { partialDay: !inProgress, inProgress, observedFromMs: null, observedToMs: null, leadingGapMs: null, trailingGapMs: 0 }
  }
  const leadingGapMs = Math.max(0, first - start)
  const trailingGapMs = Number.isFinite(at) && at >= end ? Math.max(0, end - last) : 0
  return {
    partialDay: !inProgress && (leadingGapMs > PARTIAL_GAP_MS || trailingGapMs > PARTIAL_GAP_MS),
    inProgress,
    observedFromMs: first,
    observedToMs: last,
    leadingGapMs,
    trailingGapMs,
  }
}

/** 某一天的完整汇总（真实账）。没有观测行返回 `null` —— 这是「留空」的信号。 */
export function daySummary(ledger, day, options = {}) {
  const tzOffset = Number(options.tzOffset ?? 8)
  const now = Number(options.now ?? Date.now())
  const scope = options.scope !== undefined ? options.scope : ledger.active
  const book = bookOf(ledger, scope)
  const row = book && book.days ? book.days[day] : undefined
  if (!row) return null
  /* ⚠️ 行存在 ≠ 有观测：`recordTurn` 会为「当天跑过轮次」建行，但单位字段是 null。
     旧实现只要行存在就报 `hasObservation: true`、金额 $0.00，于是**只跑过对话、还没取过
     余额的那一天会显示成「真实消费 ¥0.00」**（决策 #7 明确禁止）。
     没有观测 → 返回 null，让调用方显示 `—`。 */
  if (!hasObservation(row)) return null
  const review = needsReview(row)
  return {
    day,
    scope,
    provider: book.provider || '',
    currency: book.currency,
    amountUnits: observedDebitUnits(row),
    amount: unitsToMoney(observedDebitUnits(row)),
    openingBalance: unitsToMoney(row.openingUnits),
    currentBalance: unitsToMoney(row.lastUnits),
    observedDecrease: unitsToMoney(row.debitUnits),
    observedIncrease: unitsToMoney(row.creditUnits),
    needsReview: review,
    hasObservation: true,
    corrected: row.correction !== null && row.correction !== undefined,
    credits: row.correction ? unitsToMoney(row.correction.creditsUnits) : null,
    otherDebits: row.correction ? unitsToMoney(row.correction.otherDebitsUnits) : null,
    correctedAt: row.correction ? row.correction.at : null,
    /* ⚠️ 这里必须是**修订号数字**，不能是 `revisionOf()` 那个复合串：设置页拿
       `daySummary().revision` 回传给 `reconcileBalance` 做乐观并发校验，
       传串会导致校验永远失败（写回时也不该把串当版本号）。 */
    revision: row.revision || 0,
    revisionKey: revisionOf(row),
    turnCount: Array.isArray(row.turns) ? row.turns.length : 0,
    ...partialDayInfo(day, row, now, tzOffset),
  }
}

/**
 * 稳定性版本串：校正写入时的乐观并发校验。
 *
 * ⚠️ **必须先把返回值存成局部变量，再传给 `reconcileBalance`**：
 * 本模块的写入是**就地修改**行的，所以
 *     reconcileBalance(ledger, { revision: revisionOf(row), … })
 * 里的 `revisionOf(row)` 会在调用前就求值 —— 只要 `row` 是**同一个**对象引用
 * （从 `bookOf(ledger,scope).days[day]` 拿到的那个），它读到的就是**当前**版本，
 * 于是「拿旧版本号去改」永远不会被拒。正确写法：
 *     const rev = revisionOf(row)          // 先固定住旧版本
 *     … 用户确认 …
 *     reconcileBalance(ledger, { revision: rev, … })
 */
export function revisionOf(row) {
  if (!row) return ''
  return [row.day, row.firstAt, row.lastUnits, row.debitUnits, row.creditUnits, row.revision || 0].join(':')
}

/* ───────────────────────── 手工校正 ───────────────────────── */

/** 校正金额：非负数、最多 8 位小数。 */
function adjustmentUnits(value, required) {
  if (value === '' || value === null || value === undefined) {
    if (required) throw new Error('请填写本统计区间的累计到账金额（未充值填 0）')
    return 0
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(String(value))) {
    throw new Error('金额须为非负数，最多 8 位小数')
  }
  return moneyUnits(value)
}

/**
 * 手工校正某一天的消费额。
 *
 * 校正后的消费 = `期初余额 + 本区间累计到账 − 其它支出 − 期末余额`。
 * 这就是「充值让余额上升」时把真实消费**修回来**的办法。
 *
 * @param input `{day, credits, otherDebits, revision, confirmed, action:'apply'|'reset'}`
 */
export function reconcileBalance(ledger, input, now) {
  const at = Number(now ?? Date.now())
  const day = String((input && input.day) || '')
  if (!isDay(day)) throw new Error('请选择有效的记账日期')
  const book = bookOf(ledger, ledger.active)
  const row = book && book.days ? book.days[day] : undefined
  if (!row) throw new Error('这一天没有余额观测记录，无法校正')
  if (input.revision !== undefined && input.revision !== revisionOf(row)) {
    const err = new Error('余额或校正记录已更新，请重新打开校正窗口后核对金额')
    err.status = 409
    throw err
  }
  if (input.action !== 'reset' && input.confirmed !== true) {
    throw new Error('请先确认已核对本统计区间的全部余额调整')
  }

  let correction = null
  if (input.action !== 'reset') {
    const creditsUnits = adjustmentUnits(input.credits, true)
    const otherDebitsUnits = adjustmentUnits(input.otherDebits, false)
    const amountUnits = row.openingUnits + creditsUnits - otherDebitsUnits - row.lastUnits
    if (!Number.isSafeInteger(amountUnits) || amountUnits < 0) {
      throw new Error('校正后消费为负或超出范围，请核对统计起点与累计到账金额')
    }
    correction = {
      at,
      creditsUnits,
      otherDebitsUnits,
      amountUnits,
      /* 记下校正当时观测到的增减，方便日后核对「校正是否过期」。 */
      debitUnits: row.debitUnits,
      creditUnits: row.creditUnits,
    }
  }

  if (!Array.isArray(row.correctionLog)) row.correctionLog = []
  row.correctionLog.push({ at, previous: row.correction, next: correction })
  if (row.correctionLog.length > CORRECTION_LOG_LIMIT) {
    row.correctionLog.splice(0, row.correctionLog.length - CORRECTION_LOG_LIMIT)
  }
  row.correction = correction
  row.revision = (row.revision || 0) + 1
  ledger.updatedAt = at
  return daySummary(ledger, day, { tzOffset: input.tzOffset === undefined ? 8 : input.tzOffset, now: at })
}

/* ─────────────────────── 区间合计（本月）─────────────────────── */

/**
 * 某个日期区间的合计。
 *
 * @param options `{from, to, tzOffset, now, includeIncomplete}`
 * @returns `{from, to, amountUnits, amount, observedDays, missingDays[], incompleteDays[],
 *            needsReviewDays[], hasGap, hasAnyObservation}`
 *
 * `hasGap` = 区间里出现过**过去的**「无数据」或「不完整」的日子 → 行内要挂 `[数据不完整]`。
 * 今天不算缺口（永远「观测中」）。
 */
export function rangeSummary(ledger, options = {}) {
  const tzOffset = Number(options.tzOffset ?? 8)
  const now = Number(options.now ?? Date.now())
  const scope = options.scope !== undefined ? options.scope : ledger.active
  const book = bookOf(ledger, scope)
  const from = String(options.from || '')
  const to = String(options.to || '')
  if (!isDay(from) || !isDay(to) || from > to) throw new Error('无效的统计区间')
  /* 区间终点可能在未来（记账月的月末），用来区分「还没到的日子」与「错过的观测」。 */
  const today = dayOf(now, tzOffset)

  let amountUnits = 0
  let observedDays = 0
  const missingDays = []
  const incompleteDays = []
  const needsReviewDays = []
  const days = []

  for (let day = from; day <= to; day = dayOffset(day, 1, tzOffset)) {
    const row = book && book.days ? book.days[day] : undefined
    const info = partialDayInfo(day, row, now, tzOffset)
    /* ⚠️ 「只有估算轮次、没有观测」的日子与「完全没有行」一样：**留空**，不算已观测。
       否则本月的余额差值合计、observedDays、以及「数据不完整」判定都会被污染
       （2026-10-06：用户本月三天全被算成已观测的 ¥0.00）。 */
    if (!row || !hasObservation(row)) {
      /* 只有**已经过去**的日子才算「缺数据」。记账月的终点可能在未来
         （`monthEndOf` 给的是月末），把未来日期算成缺失会让「本月」永远挂着
         「数据不完整」，也让 missingDays 变成 29 条噪音。 */
      const future = day > today
      const hasTurns = !!(row && Array.isArray(row.turns) && row.turns.length)
      if (!info.inProgress && !future) missingDays.push(day)
      days.push({
        day,
        amountUnits: null,
        missing: true,
        /* 那天有估算轮次但没观测 —— 客户端据此在日历格子上点一个小点。 */
        hasTurns,
        inProgress: info.inProgress === true,
        future,
      })
      continue
    }
    const units = observedDebitUnits(row)
    amountUnits += units
    observedDays += 1
    if (info.partialDay) incompleteDays.push(day)
    if (needsReview(row)) needsReviewDays.push(day)
    days.push({
      day,
      amountUnits: units,
      missing: false,
      hasTurns: Array.isArray(row.turns) && row.turns.length > 0,
      partialDay: info.partialDay,
      inProgress: info.inProgress,
      needsReview: needsReview(row),
      revision: revisionOf(row),
    })
  }

  return {
    from,
    to,
    scope,
    currency: book ? book.currency : null,
    amountUnits,
    amount: unitsToMoney(amountUnits),
    observedDays,
    missingDays,
    incompleteDays,
    needsReviewDays,
    days,
    hasGap: missingDays.length > 0 || incompleteDays.length > 0,
    hasAnyObservation: observedDays > 0,
  }
}

/** 本月区间（按 `monthStartDay` 算）的合计。`to` = 记账月的结束日（可能在未来）。 */
export function monthSummary(ledger, options = {}) {
  const tzOffset = Number(options.tzOffset ?? 8)
  const now = Number(options.now ?? Date.now())
  const today = dayOf(now, tzOffset)
  const monthStartDay = options.monthStartDay
  const start = monthStartOf(today, monthStartDay, tzOffset)
  return {
    ...rangeSummary(ledger, { ...options, tzOffset, now, from: start, to: monthEndOf(today, monthStartDay, tzOffset) }),
    monthStartDay: Math.max(1, Math.min(31, Math.round(Number(monthStartDay) || 1))),
    monthStart: start,
    today,
  }
}

/* ─────────────────────── 估算账（按轮，幂等）─────────────────────── */

/**
 * 记一轮的估算用量（`turn/end` 时调用）。
 *
 * 键 = `"<sessionId>:<endSeq>"`，**按 k 幂等 upsert**（重复上报覆盖，不累加）。
 * `p`/`m` = 路由；`i`/`o`/`cr`/`cw` = 4 个桶。
 *
 * @returns `{ok:boolean, reason?:string, day, key}`
 */
export function recordTurn(ledger, turn, options = {}) {
  const tzOffset = Number(options.tzOffset ?? 8)
  const sessionId = String((turn && turn.sessionId) || '')
  const endSeq = Number(turn && turn.endSeq)
  const endTime = Number(turn && turn.endTime)
  if (sessionId === '' || !Number.isFinite(endSeq) || !Number.isFinite(endTime)) {
    return { ok: false, reason: 'bad-turn' }
  }
  const scope = String(options.scope || ledger.active || 'default')
  const day = dayOf(endTime, tzOffset)
  const book = ensureBook(ledger, scope, turn.provider, options.currency || 'CNY')
  /* 与 observeBalance 一致：写入即成为当前本（否则首次只有估算、还没有观测时，
     `ledger.active` 仍是空串，读回来的区间会查不到这本账）。 */
  if (ledger.active === '') ledger.active = scope
  let row = book.days[day]
  if (row === undefined) {
    row = {
      day,
      firstAt: null,
      lastAt: null,
      openingUnits: null,
      lastUnits: null,
      debitUnits: 0,
      creditUnits: 0,
      revision: 0,
      correction: null,
      turns: [],
    }
    book.days[day] = row
  }
  if (!Array.isArray(row.turns)) row.turns = []
  const key = sessionId + ':' + endSeq
  const record = {
    k: key,
    t: endTime,
    p: String((turn && turn.provider) || ''),
    m: String((turn && turn.model) || ''),
    i: Math.max(0, Number(turn && turn.inputTokens) || 0),
    o: Math.max(0, Number(turn && turn.outputTokens) || 0),
    cr: Math.max(0, Number(turn && turn.cacheReadTokens) || 0),
    cw: Math.max(0, Number(turn && turn.cacheWriteTokens) || 0),
  }
  let replaced = false
  for (let i = 0; i < row.turns.length; i++) {
    if (row.turns[i].k === key) {
      row.turns[i] = record
      replaced = true
      break
    }
  }
  if (!replaced) {
    row.turns.push(record)
    if (row.turns.length > MAX_TURNS_PER_DAY) row.turns.splice(0, row.turns.length - MAX_TURNS_PER_DAY)
  }
  ledger.updatedAt = Number(options.now ?? Date.now())
  return { ok: true, day, key, replaced, scope }
}

/** 取某天/某区间的估算轮次（供客户端逐轮计价 —— 峰谷按各自时刻，不能先合并桶）。 */
export function turnsInRange(ledger, options = {}) {
  const tzOffset = Number(options.tzOffset ?? 8)
  const scope = options.scope !== undefined ? options.scope : ledger.active
  const book = bookOf(ledger, scope)
  const out = []
  if (!book || !book.days) return out
  const from = String(options.from || '')
  const to = String(options.to || '')
  for (const day of Object.keys(book.days)) {
    if (isDay(from) && day < from) continue
    if (isDay(to) && day > to) continue
    const row = book.days[day]
    if (!row || !Array.isArray(row.turns)) continue
    for (const turn of row.turns) out.push({ ...turn, day })
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

/* ────────────────────────── 保留期裁剪 ────────────────────────── */

/**
 * 保留期裁剪。
 *
 * 裁剪区间 = `[当月起点的 N 个月前, 上月月末]`，**绝不动当月与今天**；
 * 幂等（再跑一次结果相同）。`N = ledgerRetentionMonths`（1–24）。
 *
 * @returns `{removedDays: string[], nextPruneDay: string|null, keptFrom: string}`
 *          `nextPruneDay` = 下一次将被裁剪的最早日期（设置页要显示给用户）
 */
export function pruneLedger(ledger, options = {}) {
  const tzOffset = Number(options.tzOffset ?? 8)
  const now = Number(options.now ?? Date.now())
  const months = Math.max(1, Math.min(24, Math.round(Number(options.ledgerRetentionMonths) || 12)))
  const today = dayOf(now, tzOffset)
  const monthStart = monthStartOf(today, options.monthStartDay, tzOffset)

  /* 裁剪上界 = 当月起始日的前一天（= 上一个月末），永远不含当月。 */
  const cutoff = dayOffset(monthStart, -1, tzOffset)

  /* 下界 = 当月起始日往回推 N 个月。注意用「月份减 N」而不是按天数近似，
     否则每个月的天数差会让边界漂移。 */
  const [year, month] = monthStart.split('-').map((part) => parseInt(part, 10))
  const targetMonth = month - months
  const lowerYear = year + Math.floor((targetMonth - 1) / 12)
  const lowerMonth = ((targetMonth - 1) % 12 + 12) % 12 + 1
  const lowerDay = Math.min(
    Math.max(1, Math.min(31, Math.round(Number(options.monthStartDay) || 1))),
    daysInMonth(lowerYear, lowerMonth),
  )
  const keepFrom = lowerYear + '-' + pad2(lowerMonth) + '-' + pad2(lowerDay)

  const removedDays = []
  for (const scope of Object.keys(ledger.books)) {
    const book = ledger.books[scope]
    if (!book || !book.days) continue
    for (const day of Object.keys(book.days)) {
      /* 三重保护：早于下界、且不早于上界之后、且绝不是今天。 */
      if (day >= keepFrom) continue
      if (day > cutoff) continue
      if (day >= monthStart) continue
      if (day === today) continue
      delete book.days[day]
      removedDays.push(day)
    }
  }
  removedDays.sort()

  /* 下一条将被裁剪的日期 = 现有最早且 < keepFrom 的那天（没有就是 null）。 */
  let nextPruneDay = null
  for (const scope of Object.keys(ledger.books)) {
    const book = ledger.books[scope]
    if (!book || !book.days) continue
    for (const day of Object.keys(book.days)) {
      if (day >= keepFrom || day >= monthStart) continue
      if (nextPruneDay === null || day < nextPruneDay) nextPruneDay = day
    }
  }
  return { removedDays, nextPruneDay, keepFrom, cutoff, retentionMonths: months }
}

/* ────────────────────────── 文件读写 ────────────────────────── */

/**
 * 账本文件路径：`<DSH_HOME>/dsh-turn-price/ledger.json`。
 *
 * ⚠️ **`DSH_HOME` 必须带 `os.homedir()` 兜底**（2026-10-05 实测，bug #4）：
 * 宿主进程里 `process.env.DSH_HOME` **是 undefined** —— 它不是 DSH 启动时注入的环境变量，
 * 只是在**用户自己的 shell**里设置的那个（本机 `C:\Users\littl\.dsh`）。
 * 桌面端宿主根本不带这个变量，于是 `throw new Error('DSH_HOME 未设置')` 直接把整个
 * 插件从 `apply()` 里炸出去 → 条目 inactive → 路由全 404。
 * 这是本插件「404」的**第四层**，前三层（YAML Date / ctx.config 无 inject / inject 写 config）
 * 修完后才露出来。
 *
 * 兜底写法与**已确认可用**的 `dsh-whale-widget` 完全一致（其 lib/index.js:22）：
 *   `process.env.DSH_HOME || path.join(os.homedir(), '.dsh')`
 *
 * 这里**不再抛异常**：路径解析失败时退回 `<用户主目录>/.dsh`，绝不让宿主起不来
 * （IMPLEMENTATION-PROMPT §10.4 的硬要求）。
 */
export function ledgerPathOf(dshHome) {
  let home = dshHome || process.env.DSH_HOME
  if (!home) {
    try {
      home = nodeOs.homedir() ? nodeOs.homedir() + '/.dsh' : ''
    } catch (err) {
      home = ''
    }
  }
  /* 真的连主目录都拿不到时才抛 —— 此时 apply 由外层 try/catch 兜住并留日志。 */
  if (!home) throw new Error('DSH_HOME 未设置，且无法解析用户主目录')
  return String(home).replace(/[\\/]+$/, '') + '/dsh-turn-price/ledger.json'
}

/**
 * 读账本；**任何异常都不抛给调用方**：
 * JSON 坏了或版本不认识 → 把原文件改名 `.corrupt-<时间戳>` 备份，然后返回空账本。
 * 这是 IMPLEMENTATION-PROMPT §10.4 的硬要求（绝不能因此让宿主起不来）。
 *
 * @returns `{ledger, recovered:boolean, backupPath:string|null, error:string|null}`
 */
export function loadLedgerSync(fs, file, fallbackFactory = emptyLedger) {
  try {
    if (!fs.existsSync(file)) return { ledger: fallbackFactory(), recovered: false, backupPath: null, error: null }
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (!isLedgerShape(parsed)) throw new Error('账本版本或结构不认识')
    return { ledger: parsed, recovered: false, backupPath: null, error: null }
  } catch (err) {
    let backupPath = null
    try {
      if (fs.existsSync(file)) {
        backupPath = file + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-')
        fs.renameSync(file, backupPath)
      }
    } catch (renameErr) {
      backupPath = null
    }
    return {
      ledger: fallbackFactory(),
      recovered: true,
      backupPath,
      error: err && err.message ? err.message : String(err),
    }
  }
}

/**
 * 原子写：`写 <path>.tmp-<pid>` → `renameSync`。
 * 中途崩溃不会留下半截 JSON（参考实现同做法）。
 */
export function saveLedgerSync(fs, file, ledger) {
  const dir = file.replace(/[\\/][^\\/]*$/, '')
  fs.mkdirSync(dir, { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(ledger), 'utf8')
  fs.renameSync(tmp, file)
  return file
}

/** 账本文件体积（设置页要显示「当前文件体积」）。 */
export function ledgerBytesSync(fs, file) {
  try {
    return fs.statSync(file).size
  } catch (err) {
    return 0
  }
}
