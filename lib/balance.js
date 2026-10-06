/**
 * dsh-turn-cost — 余额/额度适配器
 *
 * ── 来源与口径 ────────────────────────────────────────────────────────────────
 * 端点与鉴权差异照 IMPLEMENTATION-PROMPT §10.1 的表，并与本机已装的
 * `dsh-whale-widget`（MIT，`lib/index.js` 的适配表）逐个核对过。关键差异都保留：
 *
 *   · **智谱 / z.ai 不带 `Bearer`**（裸 key 放 Authorization）；
 *   · **Novita 的 `availableBalance` 要 ×0.0001**；
 *   · **MiniMax 的 `end_time` 是毫秒**；Kimi / MiniMax / 智谱都是**额度型**（不是钱）；
 *   · **OpenRouter 的 `total_credits` 是充值总额**，剩余要减去 `total_usage`；
 *   · **OpenAI 兼容网关的 `/usage` 是「美分」**，要 ×0.01；
 *   · 方舟（Ark）、OpenAI、Anthropic、Gemini、xAI… **官方没有「用 API key 查余额」的接口**
 *     → `adapter: 'none'`：只探活，余额显示 `—`（绝不猜一个数字出来）。
 *
 * ⚠️ §10.1 明确说这张表是「起点不是结论」：拿到真实 key 后必须逐个实测。
 * 本模块把「解析」与「取数」分开 —— 解析是纯函数（可离线断言），取数才碰网络。
 *
 * ── 金额纪律 ─────────────────────────────────────────────────────────────────
 * 一律不猜：字段缺失 → `{ok:false, reason:'shape'}`；HTTP 非 2xx → 分类错误；
 * 需要 baseUrl 却没给 → `{ok:false, reason:'no-base-url'}`。
 */

/** 内置适配器目录（供设置页下拉与 `test-connection` 使用）。 */
export const ADAPTERS = {
  deepseek: {
    label: 'DeepSeek 官方',
    kind: 'balance',
    currency: 'CNY',
    credentialRef: 'DEEPSEEK_API_KEY',
    url: 'https://api.deepseek.com/user/balance',
    auth: 'bearer',
    /** `balance_infos[0].total_balance`（字符串数字）。 */
    remaining: 'balance_infos[0].total_balance',
    providerIds: ['deepseek-official', 'deepseek'],
  },
  openrouter: {
    label: 'OpenRouter',
    kind: 'balance',
    currency: 'USD',
    credentialRef: 'OPENROUTER_API_KEY',
    url: 'https://openrouter.ai/api/v1/credits',
    auth: 'bearer',
    /* 剩余 = total_credits - total_usage（两个字段独立取，见 parseBalance 的 subtract 支持）。 */
    remaining: 'data.total_credits',
    subtract: 'data.total_usage',
    providerIds: ['openrouter'],
  },
  'moonshot-cn': {
    label: 'Kimi / Moonshot（国内）',
    kind: 'balance',
    currency: 'CNY',
    credentialRef: 'MOONSHOT_API_KEY',
    url: 'https://api.moonshot.cn/v1/users/me/balance',
    auth: 'bearer',
    remaining: 'data.available_balance',
    providerIds: ['moonshot'],
  },
  'moonshot-ai': {
    label: 'Kimi / Moonshot（国际）',
    kind: 'balance',
    currency: 'USD',
    credentialRef: 'MOONSHOT_INTL_API_KEY',
    url: 'https://api.moonshot.ai/v1/users/me/balance',
    auth: 'bearer',
    remaining: 'data.available_balance',
    providerIds: ['moonshot-intl'],
  },
  stepfun: {
    label: '阶跃星辰 StepFun',
    kind: 'balance',
    currency: 'CNY',
    credentialRef: 'STEPFUN_API_KEY',
    url: 'https://api.stepfun.com/v1/accounts',
    auth: 'bearer',
    remaining: 'balance',
    providerIds: ['stepfun'],
  },
  novita: {
    label: 'Novita AI',
    kind: 'balance',
    currency: 'USD',
    credentialRef: 'NOVITA_API_KEY',
    url: 'https://api.novita.ai/v3/user/balance',
    auth: 'bearer',
    remaining: 'availableBalance',
    /* 实测口径：该字段是 1/10000 美元。 */
    scale: 0.0001,
    providerIds: ['novita'],
  },
  zhipu: {
    label: '智谱 GLM（额度）',
    kind: 'quota',
    currency: 'CNY',
    credentialRef: 'ZHIPU_API_KEY',
    url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
    /* ⚠️ 智谱此接口**不带 Bearer**（裸 key）。 */
    auth: 'raw',
    quota: {
      level: 'data.level',
      /* `data.limits[]` 是扁平条目数组，**不保证顺序**：必须按 type(+unit) 选条目。
         unit=3 → 5 小时窗口；unit=6 → 周窗口。 */
      windows: [
        { key: 'rolling', label: '5h', list: 'data.limits', types: ['TOKENS_LIMIT', 'CREDIT_LIMIT'], unit: 3, percent: 'percentage', resetAt: 'nextResetTime' },
        { key: 'weekly', label: '周', list: 'data.limits', types: ['TOKENS_LIMIT', 'CREDIT_LIMIT'], unit: 6, percent: 'percentage', resetAt: 'nextResetTime' },
      ],
    },
    providerIds: ['zai', 'zhipu', 'bigmodel'],
  },
  zai: {
    label: 'z.ai（额度）',
    kind: 'quota',
    currency: 'USD',
    credentialRef: 'ZHIPU_INTL_API_KEY',
    url: 'https://api.z.ai/api/monitor/usage/quota/limit',
    auth: 'raw',
    quota: {
      level: 'data.level',
      windows: [
        { key: 'rolling', label: '5h', list: 'data.limits', types: ['TOKENS_LIMIT', 'CREDIT_LIMIT'], unit: 3, percent: 'percentage', resetAt: 'nextResetTime' },
        { key: 'weekly', label: '周', list: 'data.limits', types: ['TOKENS_LIMIT', 'CREDIT_LIMIT'], unit: 6, percent: 'percentage', resetAt: 'nextResetTime' },
      ],
    },
    providerIds: ['zai'],
  },
  'kimi-coding': {
    label: 'Kimi Coding（订阅额度）',
    kind: 'quota',
    currency: 'CNY',
    credentialRef: 'KIMI_CODING_KEY',
    url: 'https://api.kimi.com/coding/v1/usages',
    auth: 'bearer',
    quota: {
      remain: 'usage.remaining',
      total: 'usage.limit',
      resetAt: 'usage.resetTime',
    },
    providerIds: ['kimi-coding', 'kimi'],
  },
  minimax: {
    label: 'MiniMax Coding（订阅额度）',
    kind: 'quota',
    currency: 'CNY',
    credentialRef: 'MINIMAX_API_KEY',
    url: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
    auth: 'bearer',
    quota: {
      remainPct: 'model_remains[0].current_interval_remaining_percent',
      weeklyRemainPct: 'model_remains[0].current_weekly_remaining_percent',
      /* 毫秒时间戳。 */
      resetAtMs: 'model_remains[0].end_time',
    },
    providerIds: ['minimax'],
  },
  'openai-compatible': {
    label: 'OpenAI 兼容中转站（余额）',
    kind: 'balance',
    currency: 'USD',
    credentialRef: 'CUSTOM_API_KEY',
    needsBaseUrl: true,
    url: '{base}/v1/dashboard/billing/subscription',
    auth: 'bearer',
    remaining: 'hard_limit_usd',
    usage: { url: '{base}/v1/dashboard/billing/usage', auth: 'bearer', used: 'total_usage', scale: 0.01 },
    providerIds: [],
  },
  none: {
    label: '该 provider 没有余额接口（只探活）',
    kind: 'none',
    currency: 'CNY',
    credentialRef: '',
    url: '',
    auth: 'bearer',
    providerIds: [],
  },
}

/** 适配器 id 列表（设置页下拉用）。 */
export function adapterIds() {
  return Object.keys(ADAPTERS)
}

/** 取一个适配器定义；未知 id 返回 `none` 形态而不是抛错。 */
export function adapterOf(id) {
  const key = String(id || 'none')
  return ADAPTERS[key] || { ...ADAPTERS.none, label: '未知适配器：' + key }
}

/**
 * 所有适配器「建议使用的凭据名」，如 `DEEPSEEK_API_KEY`。
 *
 * ⚠️ 这些名字同时就是**模型 provider 在用的密钥**（`dsh-llm-deepseek` 的
 * `apiKeyEnv: DEEPSEEK_API_KEY` 读的就是同一个凭据名）。所以余额设置页**写入**
 * 这些名字时必须改道（见 `lib/index.js` 的 `balanceKeyRefFor()`）：
 * 2026-10-06 的真实事故就是「在账户与余额页替换密钥」把模型密钥覆盖掉了，
 * 用户随后删掉了旧密钥 → 整个对话直接 `AUTH 401 API 密钥无效`。
 *
 * @returns 去重后的凭据名数组（不含空串）
 */
export function adapterCredentialRefs() {
  const out = []
  for (const adapter of Object.values(ADAPTERS)) {
    const ref = typeof adapter.credentialRef === 'string' ? adapter.credentialRef.trim() : ''
    if (ref !== '' && out.indexOf(ref) < 0) out.push(ref)
  }
  return out
}

/* ───────────────────────── 取值路径（纯函数）───────────────────────── */

/**
 * 按点号/方括号路径取值，支持 `a.b[0].c`。
 * @returns 找不到返回 undefined（不抛）
 */
export function pickPath(value, path) {
  if (typeof path !== 'string' || path === '') return undefined
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter((part) => part !== '')
  let at = value
  for (const part of parts) {
    if (at === null || at === undefined) return undefined
    if (typeof at !== 'object') return undefined
    at = at[part]
  }
  return at
}

/** 把可能是字符串的数字转成有限数；失败返回 undefined。 */
export function asNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** 从 `data.limits[]` 里按 type(+unit) 选条目 —— **不依赖顺序**。 */
export function pickLimit(list, types, unit) {
  if (!Array.isArray(list)) return undefined
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    if (Array.isArray(types) && types.length && types.indexOf(String(item.type)) < 0) continue
    if (unit !== undefined && item.unit !== undefined && item.unit !== unit) continue
    return item
  }
  return undefined
}

/**
 * 解析一个**余额型**响应。
 * @returns `{ok:true, kind:'balance', amount, currency, raw}` 或 `{ok:false, reason}`
 */
export function parseBalance(adapter, body, options = {}) {
  const remaining = pickPath(body, adapter.remaining)
  let amount = asNumber(remaining)
  if (amount === undefined) return { ok: false, reason: 'shape', detail: '找不到余额字段 ' + adapter.remaining }

  /* OpenRouter：剩余 = total_credits - total_usage。 */
  if (adapter.subtract) {
    const used = asNumber(pickPath(body, adapter.subtract))
    if (used === undefined) return { ok: false, reason: 'shape', detail: '找不到已用字段 ' + adapter.subtract }
    amount = amount - used
  }
  if (typeof adapter.scale === 'number') amount = amount * adapter.scale
  if (!Number.isFinite(amount)) return { ok: false, reason: 'shape', detail: '余额不是有限数' }

  /* ⚠️ 币种只认**适配器自带**的那一个（3 位 ISO 码）。
     绝不能让调用方把「显示币种」传进来当余额币种 —— 用户的显示币种是符号 `¥`，
     而账本 `observeBalance` 要求 `/^[A-Z]{3}$/`，混用会让观测入账整条失败
     （2026-10-06 的第四层 bug：界面余额正常、账本一条观测都没有）。 */
  const currency = String(adapter.currency || 'CNY').toUpperCase()
  const label = options.label || adapter.label || ''
  return { ok: true, kind: 'balance', amount, currency, label, raw: body, provider: options.provider || '' }
}

/** 解析 `openai-compatible` 的「额度 − 已用」两段式响应。 */
export function parseCompatibleBalance(adapter, subscription, usageBody, options = {}) {
  const total = asNumber(pickPath(subscription, adapter.remaining))
  if (total === undefined) return { ok: false, reason: 'shape', detail: '找不到额度字段 ' + adapter.remaining }
  let used = 0
  if (adapter.usage) {
    const raw = asNumber(pickPath(usageBody, adapter.usage.used))
    if (raw === undefined) return { ok: false, reason: 'shape', detail: '找不到已用字段 ' + adapter.usage.used }
    used = raw * (typeof adapter.usage.scale === 'number' ? adapter.usage.scale : 1)
  }
  /* 币种只认适配器（见 parseBalance 的注释：显示币种绝不能混进来）。 */
  const currency = String(adapter.currency || 'USD').toUpperCase()
  return {
    ok: true,
    kind: 'balance',
    amount: total - used,
    total,
    used,
    currency,
    label: options.label || adapter.label || '',
    raw: { subscription, usage: usageBody },
    provider: options.provider || '',
  }
}

/**
 * 解析一个**额度型**响应。
 * @returns `{ok:true, kind:'quota', windows:[{key,label,percent?,remaining?,limit?,resetAt?}], level?}`
 */
export function parseQuota(adapter, body, options = {}) {
  const spec = adapter.quota
  if (!spec) return { ok: false, reason: 'shape', detail: '该适配器没有额度解析规则' }
  const windows = []
  let level

  if (Array.isArray(spec.windows)) {
    level = pickPath(body, spec.level)
    for (const win of spec.windows) {
      let item = body
      if (win.list) {
        const list = pickPath(body, win.list)
        item = win.pick ? pickPath(body, win.pick) : pickLimit(list, win.types, win.unit)
        if (item === undefined) continue
      }
      const percent = asNumber(pickPath(item, win.percent))
      if (percent === undefined) continue
      windows.push({
        key: win.key,
        label: win.label || win.key,
        percent,
        resetAt: normalizeResetAt(pickPath(item, win.resetAt)),
      })
    }
  } else {
    /* Kimi 形态：remaining + limit（绝对值，不是百分比）。 */
    if (spec.remain) {
      const remaining = asNumber(pickPath(body, spec.remain))
      const limit = spec.total ? asNumber(pickPath(body, spec.total)) : undefined
      if (remaining === undefined && limit === undefined) {
        return { ok: false, reason: 'shape', detail: '找不到额度字段 ' + spec.remain }
      }
      const percent = remaining !== undefined && limit ? Math.max(0, Math.min(100, (remaining / limit) * 100)) : undefined
      windows.push({
        key: 'plan',
        label: '套餐',
        percent,
        remaining,
        limit,
        resetAt: normalizeResetAt(pickPath(body, spec.resetAt)),
      })
    }
    /* MiniMax 形态：两个剩余百分比 + 毫秒重置时间。 */
    if (spec.remainPct) {
      const rolling = asNumber(pickPath(body, spec.remainPct))
      const weekly = asNumber(pickPath(body, spec.weeklyRemainPct))
      const resetAt = normalizeResetAt(pickPath(body, spec.resetAtMs))
      if (rolling !== undefined) windows.push({ key: 'rolling', label: '5h', percent: rolling, resetAt })
      if (weekly !== undefined) windows.push({ key: 'weekly', label: '周', percent: weekly, resetAt })
    }
  }

  if (windows.length === 0) return { ok: false, reason: 'shape', detail: '额度窗口为空（可能是订阅套餐之外、或没有 token 包）' }
  return {
    ok: true,
    kind: 'quota',
    windows: windows.map((win) => ({ ...win, label: options.label ? options.label + ' ' + win.label : win.label })),
    level: level === undefined ? undefined : level,
    currency: String(adapter.currency || 'CNY').toUpperCase(),
    raw: body,
    provider: options.provider || '',
  }
}

/** 重置时间统一成 epoch 毫秒（兼容秒 / 毫秒 / ISO 字符串）。 */
export function normalizeResetAt(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value
  const parsed = Date.parse(String(value))
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * 响应体里夹带的"假成功"错误。
 *
 * ⚠️ **实测（2026-10-05，本机真实网络探测，不带密钥）**：有几家即使鉴权失败也返回
 * **HTTP 200**，把错误写在 body 里。只看状态码会把它们当成成功，然后解析失败退化成
 * 「结构不符合预期」，用户看到的原因完全不对。实测样本：
 *
 *   智谱  200 `{"code":1001,"msg":"Header中未收到Authorization参数，无法进行身份验证。","success":false}`
 *   z.ai  200 `{"code":1001,"msg":"Authentication parameter not received in Header…","success":false}`
 *   MiniMax 200 `{"base_resp":{"status_code":1004,"status_msg":"cookie is missing, log in again"}}`
 *   Novita 400 `{"code":400,"reason":"MISSING_API_KEY",…}`   ← 连状态码都不是 401
 *
 * @returns `{reason, detail}|null`
 */
export function bodyLevelError(body) {
  if (!body || typeof body !== 'object') return null

  /* 智谱 / z.ai：`success:false` + `code`（1001 = 缺/错鉴权）。 */
  if (body.success === false) {
    const code = body.code
    const message = typeof body.msg === 'string' ? body.msg : ''
    /* 1001/1002/1003 都是鉴权类；其余按服务端错误归类，避免把业务错误说成密钥问题。 */
    const reason = code === 1001 || code === 1002 || code === 1003 ? 'unauthorized'
      : code === 429 ? 'rate-limited'
        : code >= 500 ? 'server' : 'unknown'
    return { reason, detail: (code === undefined ? '' : 'code=' + String(code) + ' ') + message }
  }

  /* MiniMax：`base_resp.status_code !== 0`。 */
  if (body.base_resp && typeof body.base_resp === 'object') {
    const code = body.base_resp.status_code
    if (code !== undefined && code !== 0) {
      const message = typeof body.base_resp.status_msg === 'string' ? body.base_resp.status_msg : ''
      /* 1004 = 需要登录 / cookie 缺失（等价于没带对密钥）。 */
      const reason = code === 1004 || code === 1002 || code === 1001 ? 'unauthorized'
        : code === 1008 ? 'rate-limited'
          : code >= 1000 ? 'unauthorized' : 'unknown'
      return { reason, detail: 'status_code=' + String(code) + ' ' + message }
    }
  }

  /* 缺密钥的另一种写法（Novita 用 400 + MISSING_API_KEY）。 */
  if (typeof body.reason === 'string' && /api[-_]?key|auth/i.test(body.reason)
    && body.code !== undefined) {
    return { reason: 'no-key', detail: String(body.reason) + (body.message ? ' ' + String(body.message) : '') }
  }

  /* Novita 实测：HTTP 400 + `{"code":400,"reason":"MISSING_API_KEY","message":"missing api-key"}`。
     状态码 400 不在 classifyFailure 的映射里，会退化成 unknown —— 这里给它准确分类。 */
  if (body.code === 400 && typeof body.reason === 'string') {
    return { reason: 'no-key', detail: String(body.reason) }
  }

  return null
}

/**
 * HTTP 状态 / 异常 → 稳定分类（交给 UI 决定文案，不解析 message）。
 *
 * @returns 'no-key' | 'unauthorized' | 'forbidden' | 'not-found' | 'rate-limited' |
 *          'server' | 'timeout' | 'network' | 'no-balance-api' | 'no-base-url' | 'shape' | 'unknown'
 */
export function classifyFailure(status, error) {
  if (error !== undefined && error !== null) {
    const name = String(error.name || '')
    const message = String(error.message || '')
    if (name === 'AbortError' || name === 'TimeoutError' || /timeout|aborted/i.test(message)) return 'timeout'
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network/i.test(message)) return 'network'
    return 'network'
  }
  const code = Number(status)
  if (!Number.isFinite(code)) return 'unknown'
  if (code === 401) return 'unauthorized'
  if (code === 403) return 'forbidden'
  if (code === 404) return 'not-found'
  if (code === 429) return 'rate-limited'
  if (code >= 500) return 'server'
  return 'unknown'
}

/* ─────────────────────────── 取数（有网络）─────────────────────────── */

/** 组装请求头。**智谱/z.ai 走 `raw`：裸 key，不加 Bearer**（实测差异）。 */
export function authHeader(auth, key) {
  if (auth === 'raw') return { Authorization: key }
  if (auth === 'bearer') return { Authorization: 'Bearer ' + key }
  if (typeof auth === 'string' && auth.indexOf('{key}') >= 0) return { Authorization: auth.replace('{key}', key) }
  return {}
}

/** 把 `{base}` 占位符换成用户填的 baseUrl（去掉尾斜杠）。 */
export function resolveUrl(url, baseUrl) {
  if (typeof url !== 'string' || url === '') return ''
  if (url.indexOf('{base}') < 0) return url
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (base === '') return ''
  return url.replace('{base}', base)
}

/**
 * 取一次余额/额度。
 *
 * @param deps `{fetch}`（测试注入桩件）
 * @param input `{adapter, key, baseUrl, provider, label, timeoutMs}`；
 *   可选 `displayCurrency` —— **只回显给界面用**（用户填的符号，如 `¥`），
 *   **绝不参与解析、也绝不进账本**（账本只认 3 位 ISO 码，见 parseBalance 的注释）。
 * @returns 成功 `{ok:true, kind, currency, displayCurrency, ...}`；失败 `{ok:false, reason, status?, detail?}`
 *          `reason:'no-key'` / `'no-balance-api'` / `'no-base-url'` 都是**预期内**的结论，不是 bug。
 */
export async function fetchBalance(deps, input) {
  const doFetch = deps && typeof deps.fetch === 'function' ? deps.fetch : (typeof fetch === 'function' ? fetch : null)
  const adapter = adapterOf(input && input.adapter)
  const timeoutMs = Math.max(1000, Math.min(30000, Number((input && input.timeoutMs) || 8000)))
  const provider = String((input && input.provider) || '')
  const label = String((input && input.label) || adapter.label || '')
  const displayCurrency = String((input && input.displayCurrency) || '')

  if (adapter.kind === 'none') return { ok: false, reason: 'no-balance-api', detail: adapter.label }
  if (doFetch === null) return { ok: false, reason: 'network', detail: '当前运行时没有 fetch' }

  const key = String((input && input.key) || '')
  if (key === '' && adapter.credentialRef !== '') return { ok: false, reason: 'no-key', detail: adapter.credentialRef }

  const url = resolveUrl(adapter.url, input && input.baseUrl)
  if (url === '') return { ok: false, reason: 'no-base-url', detail: adapter.url }

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller === null ? null : setTimeout(() => {
    try { controller.abort() } catch (err) { /* ignore */ }
  }, timeoutMs)

  const call = async (target, headers) => {
    const response = await doFetch(target, {
      signal: controller === null ? undefined : controller.signal,
      headers: { Accept: 'application/json', ...headers },
    })
    /* ⚠️ 顺序很重要：**先读 body 再看状态码**。
       实测有几家鉴权失败也返回 200（智谱/z.ai/MiniMax），只信状态码会误报成成功。 */
    let parsed
    try {
      parsed = response && typeof response.json === 'function' ? await response.json() : undefined
    } catch (err) {
      parsed = undefined
    }
    if (parsed !== undefined) {
      const embedded = bodyLevelError(parsed)
      if (embedded !== null) {
        return { ok: false, reason: embedded.reason, status: response ? response.status : undefined, detail: embedded.detail }
      }
    }
    if (!response || response.ok !== true) {
      return { ok: false, reason: classifyFailure(response ? response.status : NaN), status: response ? response.status : undefined }
    }
    if (parsed === undefined) return { ok: false, reason: 'shape', detail: '响应不是 JSON' }
    return { ok: true, body: parsed }
  }

  try {
    const headers = authHeader(adapter.auth, key)
    /* ⚠️ 三个解析函数都**不再接收** `input.currency`：币种一律取适配器自己的 ISO 码，
       用户填的显示币种只作为 `displayCurrency` 回显（见函数头注释）。 */
    if (adapter.kind === 'quota') {
      const got = await call(url, headers)
      if (!got.ok) return got
      return withDisplay(parseQuota(adapter, got.body, { provider, label }), displayCurrency)
    }
    if (adapter.usage) {
      /* openai-compatible：先额度，再已用。 */
      const sub = await call(url, headers)
      if (!sub.ok) return sub
      const usageUrl = resolveUrl(adapter.usage.url, input && input.baseUrl)
      const used = await call(usageUrl, authHeader(adapter.usage.auth, key))
      if (!used.ok) return used
      return withDisplay(parseCompatibleBalance(adapter, sub.body, used.body, { provider, label }), displayCurrency)
    }
    const got = await call(url, headers)
    if (!got.ok) return got
    return withDisplay(parseBalance(adapter, got.body, { provider, label }), displayCurrency)
  } catch (err) {
    return { ok: false, reason: classifyFailure(NaN, err), detail: err && err.message ? err.message : String(err) }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** 把「显示币种」附在解析结果上（纯回显，不参与任何计算/入账）。 */
function withDisplay(result, displayCurrency) {
  if (!displayCurrency) return result
  return { ...result, displayCurrency }
}

/**
 * 探活（`adapter: 'none'` 的 provider 只能做到这一步：证明 key 至少能通过鉴权）。
 * 一律打各家的 OpenAI 兼容 `/v1/models`。
 */
export async function probeConnection(deps, input) {
  const doFetch = deps && typeof deps.fetch === 'function' ? deps.fetch : (typeof fetch === 'function' ? fetch : null)
  const timeoutMs = Math.max(1000, Math.min(30000, Number((input && input.timeoutMs) || 8000)))
  const url = resolveUrl(String((input && input.probeUrl) || '{base}/v1/models'), input && input.baseUrl)
  if (doFetch === null) return { ok: false, reason: 'network', detail: '当前运行时没有 fetch' }
  if (url === '') return { ok: false, reason: 'no-base-url' }
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller === null ? null : setTimeout(() => {
    try { controller.abort() } catch (err) { /* ignore */ }
  }, timeoutMs)
  try {
    const response = await doFetch(url, {
      signal: controller === null ? undefined : controller.signal,
      headers: { Accept: 'application/json', ...authHeader('bearer', String((input && input.key) || '')) },
    })
    if (!response || response.ok !== true) {
      return { ok: false, reason: classifyFailure(response ? response.status : NaN), status: response ? response.status : undefined }
    }
    return { ok: true, kind: 'probe', url }
  } catch (err) {
    return { ok: false, reason: classifyFailure(NaN, err), detail: err && err.message ? err.message : String(err) }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * 失败分类 → 中文文案（集中一处，便于以后改）。
 *
 * ⚠️ **客户端半体不能 import 本文件**（模块加载器的 require 只解析平台种子与已注册
 * 工厂），所以 `lib/client.js` 里有一份**镜像**用于「宿主没起来」时的兜底显示。
 * 两份必须同步：`FAILURE_TEXT_VERSION` 是这条纪律的守卫 ——
 * 改了下面这张表就把它 +1，并同步改 `client.js` 的 `FAILURE_TEXT_VERSION`
 * （`tools/test-balance-adapters.mjs` 会断言两侧相等）。
 */
export const FAILURE_TEXT_VERSION = 2

export const FAILURE_TEXT = {
  'no-key': '没有配置密钥',
  'no-balance-api': '该 provider 没有余额接口',
  'no-base-url': '需要填写 Base URL',
  unauthorized: '密钥无效（401）',
  forbidden: '无权访问（403）',
  'not-found': '接口不存在（404，可能是 Base URL 不对）',
  'rate-limited': '请求过于频繁（429）',
  server: '服务端错误（5xx）',
  timeout: '请求超时',
  network: '网络不可达',
  shape: '返回结构不符合预期',
  unknown: '未知错误',
}

export function failureText(reason) {
  return FAILURE_TEXT[reason] || '错误：' + String(reason)
}
