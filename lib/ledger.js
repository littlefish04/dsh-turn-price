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

/** 手工校正的备注最长多少字符（备注是给人看的，不该把账本撑大）。 */
export const CORRECTION_NOTE_MAX = 200

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

/**
 * 一天的空行：**没有余额观测**的行（只有估算轮次，或用户手填了花费）。
 *
 * ⚠️ `openingUnits` / `lastUnits` 必须是 `null`（**不是 0**）：`Number(null)` 是 0，
 * 写成 0 会把「没有观测」变成「观测到 0 元」，直接违反决策 #7。判据统一走 `hasObservation()`。
 * 建行**不动** `book.lastAt` —— 那是观测的乱序判据，手填/估算都不该影响它。
 */
function emptyRow(day) {
  return {
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
 * 有手工校正时以校正值为准（用户手动填的当天花费，见 `reconcileBalance`）。
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

/**
 * 某一天的完整汇总（真实账）。**既没有观测、也没有手填**时返回 `null` —— 这是「留空」的信号。
 */
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
     没有观测**且没有手填** → 返回 null，让调用方显示 `—`。
     ⚠️ 反过来：没有观测但**有手填**时必须给汇总 —— 否则用户手填的无观测日会「填了看不见」
     （2026-10-07 用户要求「无观测的天数也能手动更改花费」）。 */
  const observed = hasObservation(row)
  const manualOnly = !observed && !!row.correction
  if (!observed && !manualOnly) return null
  const review = needsReview(row)
  return {
    day,
    scope,
    provider: book.provider || '',
    currency: book.currency,
    amountUnits: observedDebitUnits(row),
    amount: unitsToMoney(observedDebitUnits(row)),
    /* 期初/期末/增减是**观测事实**：没有观测就是 `null`（界面 `—`）。
       ⚠️ 不能用 `unitsToMoney(null)`：`Number(null)` 是 0，会显示成「观测到 ¥0.00」。 */
    openingBalance: observed ? unitsToMoney(row.openingUnits) : null,
    currentBalance: observed ? unitsToMoney(row.lastUnits) : null,
    observedDecrease: observed ? unitsToMoney(row.debitUnits) : null,
    observedIncrease: observed ? unitsToMoney(row.creditUnits) : null,
    needsReview: review,
    hasObservation: observed,
    /** 这一天没有任何余额观测，数字完全来自手填（界面据此说明，而不是当成观测值）。 */
    manualOnly,
    corrected: row.correction !== null && row.correction !== undefined,
    /* 手工校正的备注（可选）。老账本里的校正没这个字段 → 空串（界面据此不显示）。 */
    correctionNote: row.correction ? String(row.correction.note || '') : '',
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

/** 「手动更改当天花费」的金额：非负数、最多 8 位小数。 */
function correctionUnits(value) {
  if (value === '' || value === null || value === undefined) {
    throw new Error('请填写这一天的花费金额（没有花费填 0）')
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(String(value))) {
    throw new Error('金额须为非负数，最多 8 位小数')
  }
  return moneyUnits(value)
}

/**
 * 「手动更改当天花费」的备注（可选）。
 *
 * 归一化成**单行**（所有连续空白——含换行——压成一个空格）并截断到 `CORRECTION_NOTE_MAX`，
 * 因为界面把它渲染在一个表格单元格里：换行/超长会毁掉那一行的排版，也会把 `/daily.json`
 * 撑大。空 → 空串（**不是** null：文本字段「没有备注」就是空串）。
 */
function correctionNote(value) {
  const text = value === null || value === undefined ? '' : String(value)
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > CORRECTION_NOTE_MAX ? flat.slice(0, CORRECTION_NOTE_MAX) : flat
}

/**
 * 手工改写某一天的消费额（界面上叫「手动更改当天花费」）。
 *
 * ⚠️ 语义（2026-10-07 用户改版）：`input.amount` **就是**用户填的当天花费，
 * 原样写进 `correction.amountUnits`，此后 `observedDebitUnits()` 一律以它为准 ——
 * **不再**走旧的「期初余额 + 本区间累计到账 − 其它支出 − 期末余额」推导。
 * 那天余额差值多少都不再参与计算（观测值只留在 `debitUnits` / `creditUnits` 里备查）。
 *
 * ⚠️ **必须指定是哪一本账**（`input.scope`）：多来源下 `ledger.active` 只是
 * 「最后一次取数的那本」，拿它当默认会把校正写进用户没在看的账户
 * （2026-10-06 的聚合改造把这一点变成硬要求）。不给 scope 时仍退回 `ledger.active`，
 * 与旧行为一致。
 *
 * ⚠️ **没有余额观测的日子也可以手填**（2026-10-07）：没有行就建一条空行，
 * 手填之后这一天就算「有值」（`manualOnly`），不再显示成 `—`。
 *
 * @param input `{day, amount, note, revision, confirmed, action:'apply'|'reset', scope}`
 *        （`note` = 可选备注，存进 `correction.note`，界面上在当天明细里显示）
 */
export function reconcileBalance(ledger, input, now) {
  const at = Number(now ?? Date.now())
  const day = String((input && input.day) || '')
  if (!isDay(day)) throw new Error('请选择有效的记账日期')
  const scope = String((input && input.scope) || ledger.active || '')
  if (scope === '') throw new Error('账本里还没有余额来源，无法校正')
  const book = bookOf(ledger, scope)
  if (!book) throw new Error('账本里没有这本书：' + scope)
  /* ⚠️ 只能记在**余额来源本**上：估算本（`estimates`）不是来源，写进去界面没有任何地方会显示它
     —— 宁可明确报错，也不要让用户以为记上了（无观测的日子也能手填之后，这条更必须挡住）。 */
  if (!isSourceScope(scope, book)) throw new Error('这不是余额来源，无法手动记账')
  const reset = input.action === 'reset'
  let row = book && book.days ? book.days[day] : undefined
  /**
   * 没有观测的日子**也能手填花费**（2026-10-07 用户要求：插件当时没开着的那天也要能记账）。
   *
   * 这种情况下没有行就按**空行**建一条（与 `recordTurn` 建的行同形；`openingUnits`/`lastUnits`
   * 仍是 `null`，`book.lastAt` 不动 —— 那是观测的乱序判据，不能被手填污染）。
   * 建行之后 `daySummary` / 聚合都会把它当成「有值」（`manualOnly` / `sources[].manual`），
   * 界面显示成「手工填写」而不是「没有观测」，与「消费 0 元」也严格区分。
   *
   * ⚠️ `reset` 不建行：没有行 = 本来就没有任何东西可撤，凭空建一条空行只会让账本长胖。
   */
  if (row === undefined && !reset) {
    row = emptyRow(day)
    book.days[day] = row
  }
  /* `reset` 时行不存在（或没有校正）→ 没有可撤的东西，直接把当前的（可能是 `null`）汇总还回去。 */
  if (row === undefined || (reset && !row.correction)) {
    return daySummary(ledger, day, { tzOffset: input.tzOffset === undefined ? 8 : input.tzOffset, now: at, scope })
  }
  if (input.revision !== undefined && input.revision !== revisionOf(row)) {
    const err = new Error('余额或校正记录已更新，请重新打开校正窗口后核对金额')
    err.status = 409
    throw err
  }
  if (!reset && input.confirmed !== true) {
    throw new Error('请先确认要手动更改这一天的花费')
  }

  let correction = null
  if (!reset) {
    correction = {
      at,
      amountUnits: correctionUnits(input.amount),
      /* 备注可选（用户 2026-10-07 要求存下来并在当天明细里显示）。 */
      note: correctionNote(input.note),
      /* 记下校正当时观测到的增减，方便日后核对「校正是否过期」。
         没有观测的行这两个字段本来就是 0。 */
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
  return daySummary(ledger, day, { tzOffset: input.tzOffset === undefined ? 8 : input.tzOffset, now: at, scope })
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
  const manualDays = []
  const days = []

  for (let day = from; day <= to; day = dayOffset(day, 1, tzOffset)) {
    const row = book && book.days ? book.days[day] : undefined
    const info = partialDayInfo(day, row, now, tzOffset)
    /* ⚠️ 「只有估算轮次、没有观测」的日子与「完全没有行」一样：**留空**，不算已观测。
       否则本月的余额差值合计、observedDays、以及「数据不完整」判定都会被污染
       （2026-10-06：用户本月三天全被算成已观测的 ¥0.00）。
       ⚠️ 例外：**用户手填过花费**的日子（2026-10-07）必须有值 —— 那是用户给的数，
       不是「观测到 0 元」，单独记进 `manualDays`，不混进 `observedDays`。 */
    const observed = hasObservation(row)
    const manual = !observed && !!(row && row.correction)
    if (!observed && !manual) {
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
    if (observed) observedDays += 1
    if (manual) manualDays.push(day)
    if (info.partialDay) incompleteDays.push(day)
    if (needsReview(row)) needsReviewDays.push(day)
    days.push({
      day,
      amountUnits: units,
      missing: false,
      manualOnly: manual,
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
    /* 没有余额观测、但用户手填了花费的日子（它们的数字不算「观测」）。 */
    manualDays,
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

/* ──────────────── 跨本聚合（多来源余额差值求和）────────────────
 *
 * 背景（2026-10-06 用户实测的 bug，本节的**唯一**存在理由）：
 * 每个余额来源写进**自己的一本账**（scope = `<adapter>|<密钥指纹>|<显示币种>`），
 * 而 `ledger.active` 只是「最后一次写入的那一本」（`observeBalance` 每次都会改它）。
 * 汇总行原来只读 `ledger.active` ⇒ **谁最后被取数谁说了算**：
 * 用户加了一条智谱 GLM 来源后，`refreshAll` 按配置顺序取数，GLM 排在后面 →
 * `active` 变成 GLM 那本 → 「今日真实花费」显示的是 GLM 的余额差值（恒为 0），
 * 而 DeepSeek 那本账里明明记着当天花了 ¥2.33，界面上完全看不见。
 *
 * 正确口径（用户 2026-10-06 拍板）：**每个来源各算各的余额差值，再相加**。
 * 这一节就是那条口径的唯一实现 —— 宿主的路由全部走它，别再退回 `ledger.active`。
 *
 * 聚合的三条硬规则：
 *   1. **按币种分组求和**：CNY 与 USD 不能相加（相加出来的数字没有任何含义）；
 *      多币种时 `amount` / `currency` 给 `null`，由 `byCurrency` 分别列出，界面照实并排显示。
 *   2. **同一把密钥的多个入口只算一次**：智谱国内站 / z.ai 国际站用同一把 key 会返回
 *      **同一个账户**，账本里却留下两本 scope 不同的账，差值完全相同 —— 不去重就翻倍。
 *      判据 = 同一币种 + 同一密钥指纹（`nokey` 不参与）。
 *   3. **留空语义不变**（决策 #7）：**一个来源都没观测到**的那一天，聚合结果仍是 `null`
 *      → 界面显示 `—`，而不是 `¥0.00`。只要有一个来源观测到了就出数，
 *      但把「这天还有来源没观测」如实记在 `unobservedScopes` 里（并算作数据不完整）。
 */

/** 估算账专用本：轮次估算与余额观测无关，写进固定的一本（否则会在多本之间散落）。 */
export const ESTIMATE_SCOPE = 'estimates'

/** 账本里所有分本的 scope（字典序，顺序稳定 —— 聚合结果不随对象键序漂移）。 */
export function scopesOf(ledger) {
  if (!ledger || !ledger.books || typeof ledger.books !== 'object') return []
  return Object.keys(ledger.books).sort()
}

/** scope 的三段：`<adapter>|<密钥指纹>|<显示币种>`（解析不出来时各段给空串）。 */
export function partsOfScope(scope) {
  const parts = String(scope || '').split('|')
  return {
    adapter: String(parts[0] || ''),
    fingerprint: parts.length >= 3 ? String(parts[1] || '').trim().toLowerCase() : '',
    currency: parts.length >= 3 ? String(parts[2] || '').toUpperCase() : '',
  }
}

/**
 * 这是不是一本**余额来源本**（scope 的形态 = `<adapter>|<指纹>|<币种>`，三段齐全）。
 *
 * 存在的理由：账本里还有**估算本**（`estimates`，旧版本还会散出 `default` 之类），
 * 它们只存轮次、永远没有余额观测。聚合时若不排除，它们会混进「分来源」列表，
 * 让用户看到一行「未知适配器：estimates　—　没有观测」——纯粹是噪音。
 *
 * 规则：
 *   · 形态标准（三段齐全）⇒ 是来源本，**即使这一天/这本账还没有观测** ——
 *     那样才能如实报出「这个来源跑过轮次却没观测到（合计偏小）」；
 *   · 形态不标准（`estimates` / `default` / 手工改过的键）⇒ 只有**真的带过观测**
 *     才当来源本，否则按估算本排除（手工修过账本也不会把数据吞掉）。
 */
export function isSourceScope(scope, book) {
  const parts = partsOfScope(scope)
  if (parts.adapter !== '' && parts.currency !== '' && String(scope).split('|').length === 3) return true
  if (book === undefined) return false
  const days = book && book.days ? book.days : {}
  for (const day of Object.keys(days)) {
    if (hasObservation(days[day])) return true
  }
  return false
}

/** 那天**任意一本**（含估算本）有没有估算轮次 —— 日历格子上的小圆点靠它。 */
export function dayHasTurns(ledger, day) {
  for (const scope of scopesOf(ledger)) {
    const book = ledger.books[scope]
    const row = book && book.days ? book.days[day] : undefined
    if (row && Array.isArray(row.turns) && row.turns.length > 0) return true
  }
  return false
}

/**
 * 同一把密钥 + 同一币种的多本账只保留一本（其余标 `duplicateOf`）。
 *
 * 见本节开头规则 2：这不是"优化"，是**必须**做的正确性修正。
 * `nokey` / 解析不出指纹的 scope（`estimates`、`default`、不需要密钥的适配器）不参与去重。
 */
export function dedupeSources(contributors) {
  const seen = new Map()
  const kept = []
  const duplicates = []
  for (const item of contributors) {
    const fingerprint = String(item.fingerprint || '')
    if (fingerprint === '' || fingerprint === 'nokey') {
      kept.push(item)
      continue
    }
    const key = fingerprint + '|' + String(item.currency || '')
    const first = seen.get(key)
    if (first === undefined) {
      seen.set(key, item)
      kept.push(item)
      continue
    }
    duplicates.push({ ...item, duplicateOf: first.scope })
  }
  return { kept, duplicates }
}

/**
 * 一天的「跨本原料」：每个分本在这一天的观测事实（**不做任何求和**）。
 *
 * 单独导出是因为「这一天的每一本账各自是什么状态」本身就是有用的产物
 * （明细面板的分来源表格、校正时选哪一本、日历上的小圆点）。
 */
export function dayContributors(ledger, day, options = {}) {
  const tzOffset = Number(options.tzOffset ?? 8)
  const now = Number(options.now ?? Date.now())
  const out = []
  for (const scope of scopesOf(ledger)) {
    const book = ledger.books[scope]
    const row = book && book.days ? book.days[day] : undefined
    /* 估算本（`estimates` / 旧的 `default`）不是余额来源：不参与分来源明细，
       否则用户会看到一行「未知适配器：estimates」。真带观测的非标准 scope 仍然保留。 */
    if (!isSourceScope(scope, book)) continue
    const observed = hasObservation(row)
    /* 没有观测、但**用户手填了花费**的来源：也算「有值」（2026-10-07）。
       它的 `openingUnits`/`lastUnits` 仍然是 null（那是观测事实），
       金额只来自 `correction.amountUnits`。 */
    const manual = !observed && !!(row && row.correction)
    const counted = observed || manual
    const info = partialDayInfo(day, row, now, tzOffset)
    const parts = partsOfScope(scope)
    const amountUnits = counted ? observedDebitUnits(row) : null
    const firstAt = row ? Number(row.firstAt) : NaN
    const lastAt = row ? Number(row.lastAt) : NaN
    out.push({
      scope,
      adapter: parts.adapter,
      fingerprint: parts.fingerprint,
      provider: book ? String(book.provider || '') : '',
      currency: String((book && book.currency) || 'CNY').toUpperCase(),
      observed,
      /** 手填（没有余额观测）：界面用「手工填写」而不是「没有观测」来呈现它。 */
      manual,
      amountUnits,
      amount: counted ? unitsToMoney(amountUnits) : null,
      openingUnits: observed ? Number(row.openingUnits) : null,
      lastUnits: observed ? Number(row.lastUnits) : null,
      debitUnits: observed ? Number(row.debitUnits) || 0 : null,
      creditUnits: observed ? Number(row.creditUnits) || 0 : null,
      needsReview: observed ? needsReview(row) : false,
      corrected: !!(row && row.correction),
      /* 手工校正的备注（可选）；没有就是空串 —— 界面在「状态」列里显示它。 */
      correctionNote: row && row.correction ? String(row.correction.note || '') : '',
      /* ⚠️ 「没观测」的行 firstAt/lastAt 是 null，**不能**用 `Number(null) = 0` 当时间。 */
      firstAt: Number.isFinite(firstAt) && firstAt > 0 ? firstAt : null,
      lastAt: Number.isFinite(lastAt) && lastAt > 0 ? lastAt : null,
      partialDay: info.partialDay === true,
      inProgress: info.inProgress === true,
      turnCount: row && Array.isArray(row.turns) ? row.turns.length : 0,
      /* ⚠️ 只要**行存在**就给版本串（不再只在有观测时给）：手填无观测日时要拿它做乐观并发校验，
         给空串会让宿主把它当成「版本对不上」而回 409（行不存在时才给空串 = 没有版本可校验）。 */
      revision: row ? revisionOf(row) : '',
    })
  }
  return out
}

/** 按币种分组求和（金额一律整数微单位；不同币种**绝不**相加）。 */
function sumByCurrency(sources) {
  const map = new Map()
  for (const item of sources) {
    if (item.amountUnits === null || item.amountUnits === undefined) continue
    let group = map.get(item.currency)
    if (group === undefined) {
      group = { currency: item.currency, amountUnits: 0, sourceCount: 0, scopes: [] }
      map.set(item.currency, group)
    }
    group.amountUnits += item.amountUnits
    group.sourceCount += 1
    group.scopes.push(item.scope)
  }
  const list = [...map.values()].sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0))
  for (const group of list) group.amount = unitsToMoney(group.amountUnits)
  return list
}

/** 求和一组已观测来源的某个微单位字段；有任何一个缺失就返回 null（宁可留空也不给假数）。 */
function sumUnits(sources, field) {
  let total = 0
  for (const item of sources) {
    const value = item[field]
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return null
    total += Number(value)
  }
  return total
}

/** 多个来源共同的路由：完全一致才给，否则空串（不拿第一个来源冒充全部）。 */
function sharedProvider(sources) {
  let provider = null
  for (const item of sources) {
    const value = String(item.provider || '')
    if (value === '') return ''
    if (provider === null) provider = value
    else if (provider !== value) return ''
  }
  return provider === null ? '' : provider
}

/** 一天的聚合汇总（**内部**：调用方已经算好 contributors）。没有观测 → `null`。 */
function summarizeContributors(day, contributors, duplicates, options = {}) {
  const tzOffset = Number(options.tzOffset ?? 8)
  const now = Number(options.now ?? Date.now())
  /**
   * 「有值」的来源 = **有观测**的 ∪ **用户手填过花费**的（2026-10-07）。
   *
   * ⚠️ 手填**不是观测**：期初/期末/增减这些「观测事实」只统计 `observed`（手填的日子给 `null`），
   * 但**金额**要算进合计 —— 否则用户手填的无观测日在日历上会「填了看不见」。
   * 两者都区分开：`manualOnly` / `sources[].manual` 让界面如实说明数字的来源。
   */
  const counted = contributors.filter((item) => item.observed || item.manual)
  if (counted.length === 0) return null
  const observed = counted.filter((item) => item.observed)
  /** 这一天一个观测都没有，数字完全来自手填。 */
  const manualOnly = observed.length === 0

  const dayClock = partialDayInfo(day, null, now, tzOffset)
  const byCurrency = sumByCurrency(counted)
  const mixedCurrency = byCurrency.length > 1
  /* 只有单一币种时才给「合计」；多币种时 amount/currency 都是 null（见规则 1）。 */
  const only = mixedCurrency ? null : byCurrency[0]

  /* 「有来源没观测」只算**既没观测、也没手填**的：手填过的来源数字是用户给的，
     不该再让它背上「合计偏小」的提示。 */
  const unobservedScopes = contributors
    .filter((item) => !item.observed && !item.manual && item.turnCount > 0)
    .map((item) => item.scope)
  const firstAt = observed.reduce((acc, item) => (item.firstAt === null ? acc : (acc === null ? item.firstAt : Math.min(acc, item.firstAt))), null)
  const lastAt = observed.reduce((acc, item) => (item.lastAt === null ? acc : (acc === null ? item.lastAt : Math.max(acc, item.lastAt))), null)
  const turnCount = contributors.reduce((acc, item) => acc + item.turnCount, 0)

  return {
    day,
    /** 聚合口径的标记（单本口径给的是具体 scope）。 */
    scope: 'all',
    scopes: contributors.map((item) => item.scope),
    provider: sharedProvider(counted),
    currency: only ? only.currency : null,
    mixedCurrency,
    amountUnits: only ? only.amountUnits : null,
    amount: only ? only.amount : null,
    byCurrency,
    /* 分来源明细：界面按它列出「每本账各花了多少」，也是校正时要选的那一本。 */
    sources: contributors,
    /** 被去重掉的账（同一把密钥的另一个入口）—— 界面据此解释为什么某一行没被计入合计。 */
    duplicates: duplicates.map((item) => ({ scope: item.scope, duplicateOf: item.duplicateOf, provider: item.provider, amount: item.amount })),
    unobservedScopes,
    hasObservation: observed.length > 0,
    /** 这一天没有任何余额观测，数字全部来自手填。 */
    manualOnly,
    needsReview: counted.some((item) => item.needsReview === true),
    corrected: counted.some((item) => item.corrected === true),
    /* 单一币种时给合计的期初/期末/增减（多币种相加没有意义 → null）。
       ⚠️ 只统计**真观测**的来源；一个都没有 → `null`（界面 `—`），
       不能给 0 —— 那会把「没有观测」说成「观测到 0 元」。 */
    openingBalance: only && observed.length > 0 ? unitsToMoney(sumUnits(observed, 'openingUnits') ?? 0) : null,
    currentBalance: only && observed.length > 0 ? unitsToMoney(sumUnits(observed, 'lastUnits') ?? 0) : null,
    observedDecrease: only && observed.length > 0 ? unitsToMoney(sumUnits(observed, 'debitUnits') ?? 0) : null,
    observedIncrease: only && observed.length > 0 ? unitsToMoney(sumUnits(observed, 'creditUnits') ?? 0) : null,
    observedFromMs: firstAt,
    observedToMs: lastAt,
    inProgress: dayClock.inProgress === true,
    /* 「不完整」= 已过去的某天里，某个来源自己观测不完整，**或**有来源当天有轮次却没观测到
       （那样合计一定偏小 —— 必须说，不能让用户以为那就是全部）。 */
    partialDay: dayClock.inProgress !== true
      && (counted.some((item) => item.observed && item.partialDay === true) || unobservedScopes.length > 0),
    turnCount,
    /* 校正入口：默认落在**第一个有值（观测或手填）的来源**那本账上（与按 scope 排序一致、可复现）。 */
    correctionScope: counted[0].scope,
    revision: counted[0].revision,
  }
}

/**
 * 一天的**跨本聚合**汇总（多来源余额差值之和）。
 *
 * @returns 与 `daySummary` 同形（`amount` / `currency` / `partialDay` / `inProgress` …），
 *   外加 `byCurrency` / `sources` / `duplicates` / `unobservedScopes` / `mixedCurrency`；
 *   **一个来源都没观测到**时返回 `null`（界面显示 `—`，与「消费 0 元」严格区分）。
 */
export function aggregateDaySummary(ledger, day, options = {}) {
  if (!isDay(day)) throw new Error('无效的日期：' + String(day))
  const tzOffset = Number(options.tzOffset ?? 8)
  const now = Number(options.now ?? Date.now())
  const all = dayContributors(ledger, day, { tzOffset, now })
  const { kept, duplicates } = dedupeSources(all)
  return summarizeContributors(day, kept, duplicates, { tzOffset, now })
}

/**
 * 区间的**跨本聚合**汇总（`monthSummary` 的聚合版）。
 *
 * 逐天的 `days[]` 与 `rangeSummary` 同形，并额外带：
 *   · `sources[]` —— 那天每本账各自的事实（含没观测到的，`observed: false`）；
 *     传 `options.includeSources === false` 可以不带它（`/state.json` 的 history 用这个 ——
 *     分来源明细已经由 `todayReal.sources` 与区间级 `sources` 给出，逐天再带一份会让
 *     响应凭空翻倍；日历的当日详情走 `/daily.json`，那份是带的）。
 *   · `byCurrency` / `mixedCurrency` —— 多币种时 `amountUnits` 为 `null`，界面按币种并排显示；
 *   · `unobservedScopes` —— 那天有轮次却没有观测的来源（合计偏小的原因）；
 *   · `correctionScope` —— 这一天的校正默认落在哪本账上。
 */
export function aggregateRangeSummary(ledger, options = {}) {
  const tzOffset = Number(options.tzOffset ?? 8)
  const now = Number(options.now ?? Date.now())
  const includeSources = options.includeSources !== false
  const from = String(options.from || '')
  const to = String(options.to || '')
  if (!isDay(from) || !isDay(to) || from > to) throw new Error('无效的统计区间')
  const today = dayOf(now, tzOffset)

  let observedDays = 0
  const missingDays = []
  const incompleteDays = []
  const needsReviewDays = []
  const manualDays = []
  const unobservedScopesAll = []
  const days = []
  /** 区间级的「每本账」小计（本月面板用它列出分来源合计）。 */
  const perSource = new Map()

  for (let day = from; day <= to; day = dayOffset(day, 1, tzOffset)) {
    const all = dayContributors(ledger, day, { tzOffset, now })
    const { kept, duplicates } = dedupeSources(all)
    const summary = summarizeContributors(day, kept, duplicates, { tzOffset, now })
    const clock = partialDayInfo(day, null, now, tzOffset)
    const future = day > today
    /* 轮次算在**估算本**里（可能是任何一本），所以 `hasTurns` 单独跨本判定，
       不能只看参与聚合的来源本 —— 否则日历上的小圆点会消失。 */
    const hasTurns = dayHasTurns(ledger, day)

    for (const item of kept) {
      const row = perSource.get(item.scope) || {
        scope: item.scope,
        adapter: item.adapter,
        provider: item.provider,
        currency: item.currency,
        observedDays: 0,
        manualDays: 0,
        amountUnits: 0,
        turnCount: 0,
      }
      row.provider = row.provider || item.provider
      /* ⚠️ 手填的日子金额要算进小计，但**不能**混进 `observedDays`（那是观测天数）——
         否则「本月有观测天数」会把用户手填的日子也数进去（2026-10-07）。 */
      if (item.observed) row.observedDays += 1
      if (item.manual) row.manualDays += 1
      if (item.observed || item.manual) row.amountUnits += item.amountUnits
      row.turnCount += item.turnCount
      perSource.set(item.scope, row)
    }

    if (summary === null) {
      /* 与前口径一致：**只有已经过去的日子**才算「缺数据」——
         记账月终点可能在未来，把未来日期算成缺失会让「本月」永远挂着「数据不完整」。 */
      if (clock.inProgress !== true && !future) missingDays.push(day)
      days.push({
        day,
        amountUnits: null,
        amount: null,
        currency: null,
        mixedCurrency: false,
        byCurrency: [],
        missing: true,
        /* 那天有估算轮次但没观测 —— 客户端据此在日历格子上点一个小点。 */
        hasTurns,
        sources: includeSources ? kept : undefined,
        duplicates: includeSources ? duplicates : undefined,
        unobservedScopes: kept.filter((item) => !item.observed && !item.manual && item.turnCount > 0).map((item) => item.scope),
        inProgress: clock.inProgress === true,
        future,
      })
      continue
    }

    /* ⚠️ `observedDays` 只数**真有余额观测**的日子：手填的日子记进 `manualDays`
       （否则「本月有观测天数」会把用户手填的日子也数进去 —— 2026-10-07）。 */
    if (summary.hasObservation) observedDays += 1
    if (summary.manualOnly) manualDays.push(day)
    if (summary.partialDay) incompleteDays.push(day)
    if (summary.needsReview) needsReviewDays.push(day)
    for (const scope of summary.unobservedScopes) unobservedScopesAll.push(scope)
    days.push({
      day,
      amountUnits: summary.amountUnits,
      amount: summary.amount,
      currency: summary.currency,
      mixedCurrency: summary.mixedCurrency,
      byCurrency: summary.byCurrency,
      missing: false,
      /** 这一天的数字全部来自手填（没有任何余额观测）。 */
      manualOnly: summary.manualOnly,
      hasObservation: summary.hasObservation,
      hasTurns,
      sources: includeSources ? summary.sources : undefined,
      duplicates: includeSources ? summary.duplicates : undefined,
      unobservedScopes: summary.unobservedScopes,
      partialDay: summary.partialDay,
      inProgress: summary.inProgress,
      future: false,
      needsReview: summary.needsReview,
      corrected: summary.corrected,
      /* 与 `rangeSummary` 同形：校正端点要的乐观并发版本串（取自 `correctionScope` 那本账）。 */
      revision: summary.revision,
      correctionScope: summary.correctionScope,
    })
  }

  /* 区间合计：**逐天按币种求和**（天与天之间可以相加，币种之间不行）。
     多币种时 `amountUnits` / `amount` / `currency` 一律 `null` —— 只有 `byCurrency`
     是有意义的产物，界面照实并排显示（见本节规则 1）。 */
  const byCurrency = sumByCurrency(days
    .filter((day) => day.missing !== true && day.mixedCurrency !== true)
    .map((day) => ({ currency: day.currency, amountUnits: day.amountUnits })))
  const mixedCurrency = days.some((day) => day.mixedCurrency === true)
  const only = mixedCurrency || byCurrency.length !== 1 ? null : byCurrency[0]
  const totalUnits = only === null ? null : only.amountUnits
  const sources = [...perSource.values()]
    .map((row) => ({ ...row, amount: unitsToMoney(row.amountUnits) }))
    .sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0))

  return {
    from,
    to,
    scope: 'all',
    scopes: sources.map((row) => row.scope),
    currency: only === null ? null : only.currency,
    mixedCurrency,
    amountUnits: totalUnits,
    amount: totalUnits === null ? null : unitsToMoney(totalUnits),
    byCurrency,
    sources,
    observedDays,
    /* 没有余额观测、数字全靠手填的日子（它们的金额算在合计里，但不算「观测天数」）。 */
    manualDays,
    missingDays,
    incompleteDays,
    needsReviewDays,
    unobservedScopes: [...new Set(unobservedScopesAll)].sort(),
    days,
    hasGap: missingDays.length > 0 || incompleteDays.length > 0,
    hasAnyObservation: observedDays > 0,
  }
}

/** 记账月区间的**跨本聚合**合计（`monthSummary` 的聚合版）。 */
export function aggregateMonthSummary(ledger, options = {}) {
  const tzOffset = Number(options.tzOffset ?? 8)
  const now = Number(options.now ?? Date.now())
  const today = dayOf(now, tzOffset)
  const monthStartDay = options.monthStartDay
  const start = monthStartOf(today, monthStartDay, tzOffset)
  return {
    ...aggregateRangeSummary(ledger, { ...options, tzOffset, now, from: start, to: monthEndOf(today, monthStartDay, tzOffset) }),
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
  const scope = String(options.scope || ledger.active || ESTIMATE_SCOPE)
  const day = dayOf(endTime, tzOffset)
  const book = ensureBook(ledger, scope, turn.provider, options.currency || 'CNY')
  /* 与 observeBalance 一致：写入即成为当前本（否则首次只有估算、还没有观测时，
     `ledger.active` 仍是空串，读回来的区间会查不到这本账）。 */
  if (ledger.active === '') ledger.active = scope
  let row = book.days[day]
  if (row === undefined) {
    row = emptyRow(day)
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

/**
 * 取某天/某区间的估算轮次 —— **跨全部本**，并按 `k`（`<sessionId>:<endSeq>`）去重。
 *
 * 为什么需要它（同一类 bug 的另一半）：旧实现按 `ledger.active` 记也按 `ledger.active` 读，
 * 而 `active` 会随每次余额观测漂移 —— 同一轮可能被写进不止一本账（增量路径写当前本、
 * 启动回填时 active 已经换成别本），读取时只看一本就会**丢轮次**
 * （2026-10-06 实测：某一轮只在 deepseek 本里，读 zhipu 本时它就不见了）。
 *
 * 去重规则：同一 `k` 只留一条；两条都有路由时留**先出现**的那条（scope 字典序，
 * 结果可复现）；只有一条带路由时留带路由的那条（计价必须有路由）。
 */
export function turnsAcrossBooks(ledger, options = {}) {
  const from = String(options.from || '')
  const to = String(options.to || '')
  const byKey = new Map()
  for (const scope of scopesOf(ledger)) {
    const book = ledger.books[scope]
    if (!book || !book.days) continue
    for (const day of Object.keys(book.days)) {
      if (isDay(from) && day < from) continue
      if (isDay(to) && day > to) continue
      const row = book.days[day]
      if (!row || !Array.isArray(row.turns)) continue
      for (const turn of row.turns) {
        const key = String((turn && turn.k) || '')
        const record = { ...turn, day, scope }
        const prev = byKey.get(key)
        if (prev === undefined) {
          byKey.set(key, record)
          continue
        }
        const prevHasRoute = String(prev.p || '') !== ''
        const nowHasRoute = String(record.p || '') !== ''
        if (!prevHasRoute && nowHasRoute) byKey.set(key, record)
      }
    }
  }
  const out = [...byKey.values()]
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
