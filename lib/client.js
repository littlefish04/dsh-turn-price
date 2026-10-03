/**
 * dsh-turn-price — Client 半体
 *
 * 以 window.__ModuleLoader__.load 注册的懒加载 CJS 工厂（与 dsh-plugin-notify-sound
 * / dsh-graded-mode 同构）。浏览器侧职责：
 *
 *   1. 在 `conversation.chat.turnTail`（「已完成回合操作行之前」的具名座位）注册一格，
 *      为每个完成的回合渲染一行花费金额（可点击展开明细）。
 *   2. 在 `settings.section` 注册「每轮花费」设置页：按模型分页签维护价格表，
 *      支持峰谷系数与限时特价。
 *   3. 价格表存在插件自己的 Cordis Config 里（见 lib/index.js），客户端通过
 *      `ctx.configForms.get('turn-cost')` 读写 —— 落盘到 profile 的 cordis.patch.yml。
 *
 * ── token 用量的来源（不重复计算，直接复用官方结果）──────────────────────────
 * DSH 内置的「本轮用量」面板由 @deepseek-ai/dsh-client-ui-chat 的 turn-tail 定义产出：
 *     const tokenUsage = deriveTurnTokenUsage(events)   // @deepseek-ai/dsh-token-meter/client
 * 并把结果挂在 turn-tail 的 Location data 上（`turn.data.get('turn-tail')`）。
 * 官方 dsh-client-ui-deliverables 正是这样读同一份数据的（`owner.turn.data.get('deliverables')`），
 * 所以本插件沿用同一通道：
 *     turn.data.get('turn-tail') -> { time, tokenUsage: { uncachedInputTokens, outputTokens,
 *                                    cacheReadTokens?, cacheWriteTokens?, reasoningTokens?, routes? } }
 * 好处：金额所用的 token 数与用户点开面板看到的数字**逐项一致**，且不含任何估算。
 * 该项缺失（回合未终结 / 用量不可证）时不渲染任何东西。
 *
 * ── 价格口径 ─────────────────────────────────────────────────────────────────
 *   token 类别与内置面板一一对应：未缓存输入 / 缓存命中 / 缓存写入 / 输出。
 *   金额 = Σ(类别 token 数 ÷ perTokens × 该类别的生效单价)。
 *   生效单价按**回合结束时间**（tail.time，时区 tzOffset，默认 +8 北京时间）判定：
 *     ① 限时特价 promos（绝对时间区间）——优先级最高；
 *     ② 峰谷规则 rules（一周内的循环时段，价格 × multiplier）；
 *     ③ 基础价。
 *   同类规则多条命中时，**列表靠后的优先**（便于后来追加例外）。
 *   单价改动后无需重算历史：金额由当前价格表现算，配置一变所有回合立即重绘。
 */
/**
 * 模块 id 必须**等于 package.json 的包名**。
 *
 * @deepseek-ai/dsh-client-modules 按包名索引浏览器半体：注册成别的 id，加载器
 * 会认为它要的那个模块没有出现而重试，第二次执行就抛
 *     client-modules: duplicate factory registration for "<旧名>"
 * 整个 web boot 直接起不来（"1 entry did not activate"）。
 * 这正是 dsh-turn-cost → dsh-turn-price 改名时踩过的坑 —— 改包名时必须同步改这里。
 *
 * 别和下面 SETTINGS_NS 搞混：那个是 profile 条目 id（cordis.patch.yml 里的 `- id:`），
 * 与本模块 id 无关，故意保持 `turn-cost` 不变，否则用户已保存的价格表会失联。
 */
window.__ModuleLoader__.load({
  id: 'dsh-turn-price',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    /**
     * 设置命名空间 = profile 条目 id（cordis.patch.yml 里 `- id: turn-cost`）。
     * dsh-settings 用 entry.options.id 作为 ns，改 id 必须同步改这里。
     */
    var SETTINGS_NS = 'turn-cost'
    var LOCAL_KEY = 'dsh-turn-price:config:v1'
    var CSS_TAG_ID = 'dsh-turn-price/style'

    /* ────────────────────────────── 样式 ────────────────────────────── */
    var CSS = [
      /* 配色纪律：只允许用 --dsw-alias-* 语义变量，且不写死兜底色。
         写死的浅色兜底（如 var(--x,#fff)）一旦变量名不存在或主题未定义，
         文字色跟着主题变、底色却停在浅色，深色下就会糊成一片。
         tools/test-theme-tokens.mjs 会强制校验这两条。 */
      /* 回合尾部的一行：芯片用半透明叠加色，自动贴合对话背景 */
      '.dtc-row{display:flex;flex-direction:column;gap:6px;margin:2px 0 0;color-scheme:light;}',
      'body[data-ds-dark-theme] .dtc-row{color-scheme:dark;}',
      '.dtc-chip{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;',
      'font:inherit;font-size:12px;line-height:18px;cursor:pointer;user-select:none;',
      'padding:2px 9px;border-radius:var(--dsw-radius-sm);',
      'color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);',
      'border:1px solid var(--dsw-alias-border-l2);}',
      '.dtc-chip:hover{background:var(--dsw-alias-interactive-bg-active);}',
      '.dtc-sign{font-weight:600;opacity:.75;}',
      '.dtc-amount{font-variant-numeric:tabular-nums;font-weight:600;',
      'color:var(--dsw-alias-label-primary);}',
      '.dtc-badge{font-size:11px;padding:0 5px;border-radius:var(--dsw-radius-xs);',
      'color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);',
      'border:1px solid var(--dsw-alias-border-l2);}',
      /* 峰谷/特价徽标：底色取主题状态色三级（浅色=淡彩、深色=深彩），
         文字统一用 label-primary，两种主题都是「浅底深字 / 深底浅字」。 */
      '.dtc-badge-peak{color:var(--dsw-alias-label-primary);border-color:transparent;',
      'background:var(--dsw-alias-state-warn-tertiary);}',
      '.dtc-badge-promo{color:var(--dsw-alias-label-primary);border-color:transparent;',
      'background:var(--dsw-alias-state-success-tertiary);}',
      '.dtc-caret{opacity:.6;font-size:10px;}',
      /* 明细面板：浮在对话背景之上，用宿主抬升阴影而不是自画边框 */
      '.dtc-panel{max-width:520px;border-radius:var(--dsw-radius-lg);padding:10px 12px;',
      '--dsw-elevation-stroke-color:var(--dsw-alias-border-l2);',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);',
      'box-shadow:var(--dsw-elevation-panel);color-scheme:light;}',
      'body[data-ds-dark-theme] .dtc-panel{color-scheme:dark;}',
      '.dtc-panel-title{display:flex;justify-content:space-between;gap:10px;font-size:12px;',
      'font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:6px;}',
      '.dtc-meta{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);margin-bottom:8px;}',
      '.dtc-table{width:100%;border-collapse:collapse;font-size:11.5px;',
      'color:var(--dsw-alias-label-secondary);}',
      '.dtc-table th{text-align:left;font-weight:500;padding:3px 0;',
      'color:var(--dsw-alias-label-tertiary);}',
      '.dtc-table td{padding:3px 0;border-top:1px solid var(--dsw-alias-border-l1);',
      'font-variant-numeric:tabular-nums;}',
      '.dtc-table td.dtc-num,.dtc-table th.dtc-num{text-align:right;}',
      '.dtc-total{display:flex;justify-content:space-between;gap:10px;margin-top:8px;',
      'padding-top:7px;border-top:1px solid var(--dsw-alias-border-l2);',
      'font-size:12px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;}',
      '.dtc-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-top:6px;}',
      /* 设置页：面/背分层用 卡片=module-platform、嵌套块=bg-base。
         浅色下 layer-1/2/3 全是白，只有这两个面能拉开层次；深色下前者更亮、后者更暗。 */
      '.dtc-page{display:flex;flex-direction:column;gap:18px;max-width:760px;',
      'color:var(--dsw-alias-label-primary);color-scheme:light;}',
      'body[data-ds-dark-theme] .dtc-page{color-scheme:dark;}',
      '.dtc-sec{display:flex;flex-direction:column;gap:10px;}',
      '.dtc-sec-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.dtc-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.dtc-field{display:flex;align-items:center;gap:10px;}',
      '.dtc-field-label{font-size:12.5px;color:var(--dsw-alias-label-primary);min-width:96px;}',
      '.dtc-check{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;user-select:none;',
      'color:var(--dsw-alias-label-primary);}',
      '.dtc-check input{accent-color:var(--dsw-alias-state-business-primary);}',
      '.dtc-input{font:inherit;font-size:12px;min-width:0;width:110px;',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);',
      'border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);padding:5px 8px;}',
      '.dtc-input:focus{border-color:var(--dsw-alias-state-business-primary);}',
      '.dtc-input-wide{width:210px;}',
      '.dtc-input-full{flex:1;width:auto;}',
      '.dtc-btn{font:inherit;font-size:12px;cursor:pointer;flex:none;',
      'color:var(--dsw-alias-label-primary);background:transparent;',
      'border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);padding:5px 10px;}',
      '.dtc-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dtc-btn:disabled{opacity:.5;cursor:default;}',
      /* 主按钮：直接借宿主的按钮色，深色下自动变成「浅底黑字」 */
      '.dtc-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);',
      'color:var(--dsw-alias-label-primary-foreground);}',
      '.dtc-btn-primary:hover{background:var(--dsw-alias-button-primary-hover);}',
      '.dtc-tabs{display:flex;flex-wrap:wrap;gap:6px;}',
      '.dtc-tab{font:inherit;font-size:12px;cursor:pointer;padding:4px 10px;border-radius:var(--dsw-radius-sm);',
      'color:var(--dsw-alias-label-secondary);background:transparent;',
      'border:1px solid var(--dsw-alias-border-l2);}',
      '.dtc-tab:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dtc-tab-active{color:var(--dsw-alias-label-primary);font-weight:600;',
      'background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l3);}',
      '.dtc-card{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:var(--dsw-radius-lg);',
      'border:1px solid var(--dsw-alias-border-l4);',
      'background:var(--dsw-alias-bg-module-platform);}',
      '.dtc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px 14px;}',
      '.dtc-sub{display:flex;flex-direction:column;gap:7px;padding:9px 10px;border-radius:var(--dsw-radius-md);',
      'border:1px solid var(--dsw-alias-border-l1);',
      'background:var(--dsw-alias-bg-base);}',
      '.dtc-sub-head{display:flex;align-items:center;justify-content:space-between;gap:8px;',
      'font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.dtc-days{display:flex;gap:4px;align-items:center;}',
      '.dtc-day{font-size:11px;cursor:pointer;user-select:none;padding:2px 6px;border-radius:var(--dsw-radius-xs);',
      'border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);}',
      '.dtc-day:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dtc-day-on{color:var(--dsw-alias-label-primary);font-weight:600;',
      'background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l3);}',
      '.dtc-inline{display:flex;align-items:center;gap:6px;font-size:12px;',
      'color:var(--dsw-alias-label-secondary);}',
      /* 状态提示做成带底色的小条，状态色只体现在底色上。
         不能拿 state-*-primary 当浅色主题的文字色：绿 500 在白底上只有 2.1:1、
         琥珀 600 只有 2.6:1，属于「看得见但读不清」，深色下反而没问题。 */
      '.dtc-status{font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm);padding:3px 8px;',
      'color:var(--dsw-alias-label-primary);}',
      '.dtc-ok{background:var(--dsw-alias-state-success-tertiary);}',
      '.dtc-warn{background:var(--dsw-alias-state-warn-tertiary);}',
      '.dtc-err{background:var(--dsw-alias-interactive-bg-hover-danger);}',
      '.dtc-preview{font-size:11.5px;line-height:18px;font-variant-numeric:tabular-nums;',
      'color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-markdown-code-block);',
      'border-radius:var(--dsw-radius-sm);padding:6px 8px;overflow-wrap:anywhere;}',
      '.dtc-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}',
      '.dtc-spacer{flex:1;}',
    ].join('\n')
    /**
     * 样式版本：改了上面的 CSS 就 +1。
     * 只按「有没有同 id 的 <style>」去重的话，插件热重载时旧节点会挡住新样式，
     * 表现为「改完代码界面没变」，所以这里带版本号并清掉旧节点。
     */
    var CSS_VERSION = '2'
    if (typeof document !== 'undefined') {
      var staleStyles = document.querySelectorAll('style[data-plugin="dsh-turn-price"]')
      var cssCurrent = staleStyles.length === 1 && staleStyles[0].dataset.pluginCssVersion === CSS_VERSION
      if (!cssCurrent) {
        for (var styleIndex = 0; styleIndex < staleStyles.length; styleIndex += 1) staleStyles[styleIndex].remove()
        var styleTag = document.createElement('style')
        styleTag.dataset.plugin = 'dsh-turn-price'
        styleTag.dataset.pluginCss = CSS_TAG_ID
        styleTag.dataset.pluginCssVersion = CSS_VERSION
        styleTag.textContent = CSS
        document.head.appendChild(styleTag)
      }
    }

    /* ──────────────────────── 默认值 / 净化 ──────────────────────── */

    /** 与 lib/index.js 的 Config 默认值保持一致（服务端不可用时的兜底）。 */
    var DEEPSEEK_PEAK_RULES = [
      { label: '高峰', days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00', multiplier: 2 },
      { label: '高峰', days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00', multiplier: 2 },
    ]

    function deepseekModel(model, label, input, cacheRead, output) {
      return {
        model: model,
        provider: '',
        label: label,
        input: input,
        cacheRead: cacheRead,
        cacheWrite: 0,
        output: output,
        rules: DEEPSEEK_PEAK_RULES.map(function (r) { return Object.assign({}, r) }),
        promos: [],
      }
    }

    function defaultConfig() {
      return {
        enabled: true,
        currency: '¥',
        perTokens: 1000000,
        decimals: 4,
        tzOffset: 8,
        unknownModel: 'hide',
        fallback: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        models: [
          deepseekModel('deepseek-flash', 'DeepSeek Flash', 1, 0.02, 4),
          deepseekModel('deepseek-v4-pro', 'DeepSeek V4 Pro', 4.5, 0.15, 13.5),
        ],
      }
    }

    function num(value, fallback) {
      var n = typeof value === 'number' ? value : parseFloat(value)
      if (typeof n !== 'number' || !isFinite(n)) return fallback === undefined ? 0 : fallback
      return n
    }

    function str(value, fallback) {
      return typeof value === 'string' ? value : (fallback === undefined ? '' : fallback)
    }

    function bool(value, fallback) {
      return typeof value === 'boolean' ? value : fallback
    }

    /** 兼容 schemastery 的 Volatile 引用（宿主侧 .get() 取值）与普通值。 */
    function plain(value) {
      if (value === null || value === undefined) return value
      if (typeof value === 'object' && typeof value.get === 'function' && typeof value.toJSON !== 'function') {
        try { return value.get() } catch (err) { /* 非 Volatile，继续按普通对象处理 */ }
      }
      return value
    }

    function ownKeys(obj) {
      return Object.keys(obj || {})
    }

    function sanitizeRule(raw) {
      var r = plain(raw) || {}
      var days = Array.isArray(r.days) ? r.days.map(function (d) { return num(d, 0) }) : []
      return {
        label: str(r.label, '高峰'),
        days: days.length ? days : [1, 2, 3, 4, 5],
        start: str(r.start, '09:00'),
        end: str(r.end, '12:00'),
        multiplier: num(r.multiplier, 2),
      }
    }

    function sanitizePromo(raw) {
      var p = plain(raw) || {}
      return {
        label: str(p.label, '限时优惠'),
        from: str(p.from, ''),
        to: str(p.to, ''),
        multiplier: num(p.multiplier, 1),
        input: num(p.input, -1),
        cacheRead: num(p.cacheRead, -1),
        cacheWrite: num(p.cacheWrite, -1),
        output: num(p.output, -1),
      }
    }

    function sanitizeModel(raw) {
      var m = plain(raw) || {}
      var rules = Array.isArray(m.rules) ? m.rules.map(sanitizeRule) : []
      var promos = Array.isArray(m.promos) ? m.promos.map(sanitizePromo) : []
      return {
        model: str(m.model, ''),
        provider: str(m.provider, ''),
        label: str(m.label, ''),
        input: num(m.input, 0),
        cacheRead: num(m.cacheRead, 0),
        cacheWrite: num(m.cacheWrite, 0),
        output: num(m.output, 0),
        rules: rules,
        promos: promos,
      }
    }

    function sanitize(raw) {
      var cfg = plain(raw)
      var source = (cfg && typeof cfg === 'object') ? cfg : {}
      var d = defaultConfig()
      var fallbackRaw = plain(source.fallback) || {}
      return {
        enabled: bool(source.enabled, d.enabled),
        currency: str(source.currency, d.currency) || d.currency,
        perTokens: num(source.perTokens, d.perTokens) || d.perTokens,
        decimals: Math.max(0, Math.min(8, Math.round(num(source.decimals, d.decimals)))),
        tzOffset: Math.max(-12, Math.min(14, num(source.tzOffset, d.tzOffset))),
        unknownModel: str(source.unknownModel, d.unknownModel) === 'fallback' ? 'fallback' : 'hide',
        fallback: {
          input: num(fallbackRaw.input, 0),
          cacheRead: num(fallbackRaw.cacheRead, 0),
          cacheWrite: num(fallbackRaw.cacheWrite, 0),
          output: num(fallbackRaw.output, 0),
        },
        models: (Array.isArray(source.models) ? source.models : d.models).map(sanitizeModel),
      }
    }

    /* ──────────────────────── 价格引擎 ──────────────────────── */

    var DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    /** 设置页里 7 个复选框的顺序：周一到周日。 */
    var DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
    var PRICE_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output']
    var PRICE_LABELS = {
      input: '未缓存输入',
      cacheRead: '缓存命中',
      cacheWrite: '缓存写入',
      output: '输出',
    }

    /** "HH:mm" -> 当天分钟数；非法返回 null。 */
    function parseHM(text) {
      var m = /^(\d{1,2}):(\d{1,2})$/.exec(str(text, '').trim())
      if (m === null) return null
      var hh = parseInt(m[1], 10)
      var mm = parseInt(m[2], 10)
      if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) return null
      return hh * 60 + mm
    }

    /**
     * "YYYY-MM-DD" 或 "YYYY-MM-DDTHH:mm"（可带空格分隔）解析为 epoch 毫秒，
     * 时间按 tzOffset 时区的墙上时间解释。空串返回 null（表示该端不设限）。
     */
    function parseWall(text, tzOffset) {
      var s = str(text, '').trim()
      if (s === '') return null
      var m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2}))?$/.exec(s)
      if (m === null) return null
      var utc = Date.UTC(
        parseInt(m[1], 10),
        parseInt(m[2], 10) - 1,
        parseInt(m[3], 10),
        m[4] === undefined ? 0 : parseInt(m[4], 10),
        m[5] === undefined ? 0 : parseInt(m[5], 10),
        0, 0,
      )
      if (!isFinite(utc)) return null
      return utc - tzOffset * 3600000
    }

    /** epoch 毫秒 -> tzOffset 时区下的 { day, minutes, ymd, hm }。 */
    function wallClock(ms, tzOffset) {
      var d = new Date(ms + tzOffset * 3600000)
      var pad = function (n) { return (n < 10 ? '0' : '') + n }
      return {
        day: d.getUTCDay(),
        minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
        ymd: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()),
        hm: pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()),
        dayName: DAY_NAMES[d.getUTCDay()],
      }
    }

    /** 峰谷规则是否命中该时刻。start === end 视为全天。 */
    function ruleMatches(rule, ms, tzOffset) {
      var days = Array.isArray(rule.days) && rule.days.length ? rule.days : [0, 1, 2, 3, 4, 5, 6]
      var clock = wallClock(ms, tzOffset)
      var hit = false
      for (var i = 0; i < days.length; i++) if (num(days[i], -1) === clock.day) { hit = true; break }
      if (!hit) return false
      var start = parseHM(rule.start)
      var end = parseHM(rule.end)
      if (start === null || end === null) return false
      if (start === end) return true
      if (start < end) return clock.minutes >= start && clock.minutes < end
      /* 跨零点 */
      return clock.minutes >= start || clock.minutes < end
    }

    /** 限时特价是否命中该时刻（from / to 为空表示该端不设限）。 */
    function promoMatches(promo, ms, tzOffset) {
      var from = parseWall(promo.from, tzOffset)
      var to = parseWall(promo.to, tzOffset)
      if (from === null && to === null) return false /* 两端都不填 = 未启用，避免误伤 */
      if (from !== null && ms < from) return false
      if (to !== null && ms > to) return false
      return true
    }

    /**
     * 解析某个模型条目在某时刻的生效单价。
     * 优先级：限时特价 > 峰谷规则 > 基础价；同类多条命中时列表靠后者优先。
     * @returns {{ unit: object, rule: object|null }}
     */
    function resolveUnitPrices(entry, ms, cfg) {
      var unit = {
        input: num(entry.input, 0),
        cacheRead: num(entry.cacheRead, 0),
        cacheWrite: num(entry.cacheWrite, 0),
        output: num(entry.output, 0),
      }
      if (!isFinite(ms)) return { unit: unit, rule: null }

      var promos = Array.isArray(entry.promos) ? entry.promos : []
      var promo = null
      for (var i = 0; i < promos.length; i++) if (promoMatches(promos[i], ms, cfg.tzOffset)) promo = promos[i]
      if (promo !== null) {
        /* 特价自成一套价格：从**基础价**乘 promo.multiplier，再套用各项绝对覆盖价。
           刻意不叠加峰谷系数 —— 特价区间代表「这段时间就是这个价」，
           叠加会让「只改输出价」这类意图变得难以预测。 */
        var pm = num(promo.multiplier, 1)
        var scaled = {}
        for (var a = 0; a < PRICE_KEYS.length; a++) {
          var k = PRICE_KEYS[a]
          var override = num(promo[k], -1)
          scaled[k] = override >= 0 ? override : unit[k] * pm
        }
        return {
          unit: scaled,
          rule: {
            kind: 'promo',
            label: str(promo.label, '') || '限时优惠',
            multiplier: pm,
            detail: str(promo.from, '') + ' ~ ' + str(promo.to, ''),
          },
        }
      }

      var rules = Array.isArray(entry.rules) ? entry.rules : []
      var rule = null
      for (var j = 0; j < rules.length; j++) if (ruleMatches(rules[j], ms, cfg.tzOffset)) rule = rules[j]
      if (rule !== null) {
        var rm = num(rule.multiplier, 1)
        var out = {}
        for (var b = 0; b < PRICE_KEYS.length; b++) out[PRICE_KEYS[b]] = unit[PRICE_KEYS[b]] * rm
        return {
          unit: out,
          rule: {
            kind: 'peak',
            label: str(rule.label, '') || '峰谷',
            multiplier: rm,
            detail: str(rule.start, '') + '–' + str(rule.end, ''),
          },
        }
      }
      return { unit: unit, rule: null }
    }

    /** 在价格表里找条目：优先 provider + model 精确匹配，其次 provider 不限的条目。 */
    function findEntry(cfg, provider, model) {
      var models = Array.isArray(cfg.models) ? cfg.models : []
      var wantModel = str(model, '').trim().toLowerCase()
      var wantProvider = str(provider, '').trim().toLowerCase()
      var wildcard = null
      for (var i = 0; i < models.length; i++) {
        var m = models[i]
        if (str(m.model, '').trim().toLowerCase() !== wantModel) continue
        var mp = str(m.provider, '').trim().toLowerCase()
        if (mp === '' && wildcard === null) wildcard = m
        else if (mp !== '' && mp === wantProvider) return m
      }
      return wildcard
    }

    /**
     * 计算一份 tokenUsage 的金额。
     * @returns {{ ok: boolean, reason?: string, total?, parts?, rule?, entry?, route?, routes?, ms? }}
     */
    function computeCost(usage, cfg, ms) {
      var routes = Array.isArray(usage.routes) ? usage.routes : []
      /* routes 为空 = 无法确定模型；多路由时取最后一次尝试的路由（deriveTurnTokenUsage
         按尝试顺序去重，末位即最近一次），并在明细里标注。 */
      var route = routes.length ? routes[routes.length - 1] : null
      var entry = route === null ? null : findEntry(cfg, route.provider, route.model)
      if (entry === null) {
        if (cfg.unknownModel !== 'fallback') return { ok: false, reason: 'unknown-model', route: route, routes: routes, ms: ms }
        entry = {
          model: route === null ? '(未知模型)' : route.model,
          provider: route === null ? '' : route.provider,
          label: '兜底价',
          input: cfg.fallback.input,
          cacheRead: cfg.fallback.cacheRead,
          cacheWrite: cfg.fallback.cacheWrite,
          output: cfg.fallback.output,
          rules: [],
          promos: [],
        }
      }
      var resolved = resolveUnitPrices(entry, ms, cfg)
      var per = num(cfg.perTokens, 1000000) || 1000000
      var tokensByKey = {
        input: num(usage.uncachedInputTokens, 0),
        cacheRead: num(usage.cacheReadTokens, 0),
        cacheWrite: num(usage.cacheWriteTokens, 0),
        output: num(usage.outputTokens, 0),
      }
      var parts = []
      var total = 0
      for (var i = 0; i < PRICE_KEYS.length; i++) {
        var key = PRICE_KEYS[i]
        var tokens = tokensByKey[key]
        var unitPrice = num(resolved.unit[key], 0)
        var amount = tokens / per * unitPrice
        total += amount
        parts.push({ key: key, label: PRICE_LABELS[key], tokens: tokens, unit: unitPrice, amount: amount })
      }
      return {
        ok: true,
        total: total,
        parts: parts,
        rule: resolved.rule,
        entry: entry,
        route: route,
        routes: routes,
        ms: ms,
      }
    }

    /** 金额格式化：小数位不足时用更多有效位，避免小额一律显示 ¥0.0000。 */
    function formatMoney(value, cfg) {
      var decimals = Math.max(0, Math.min(8, Math.round(num(cfg.decimals, 4))))
      var sign = value < 0 ? '-' : ''
      var abs = Math.abs(value)
      var text = abs.toFixed(decimals)
      if (parseFloat(text) === 0 && abs > 0) {
        /* 小于显示精度：给 3 位有效数字，避免显示成 0。 */
        text = abs.toPrecision(3)
        if (text.indexOf('e') >= 0) text = abs.toExponential(2)
      }
      return sign + str(cfg.currency, '¥') + text
    }

    function formatTokens(value) {
      var n = num(value, 0)
      return n.toLocaleString('en-US')
    }

    /** 时间字段可能是 epoch 毫秒/秒、ISO 字符串或 Date。 */
    function toMs(value) {
      if (value === null || value === undefined) return NaN
      if (typeof value === 'number') return value < 1e12 ? value * 1000 : value
      if (value instanceof Date) return value.getTime()
      var parsed = Date.parse(String(value))
      return isNaN(parsed) ? NaN : parsed
    }

    /** 读取内置 turn-tail 定义发布的回合数据（含 tokenUsage）。 */
    function readTurnTail(turn) {
      try {
        if (!turn || !turn.data) return null
        var data = turn.data
        var value = typeof data.get === 'function' ? data.get('turn-tail') : data['turn-tail']
        if (!value || typeof value !== 'object') return null
        return value
      } catch (err) {
        return null
      }
    }

    /* ──────────────────────── 配置存储 ──────────────────────── */

    function readLocal() {
      try {
        var raw = window.localStorage.getItem(LOCAL_KEY)
        if (!raw) return null
        return JSON.parse(raw)
      } catch (err) {
        return null
      }
    }

    function writeLocal(value) {
      try {
        window.localStorage.setItem(LOCAL_KEY, JSON.stringify(value))
      } catch (err) {
        /* 隐私模式 / 配额：忽略，仅失去本地兜底 */
      }
    }

    /**
     * 配置存储：优先用 0.2 的服务端通道 ctx.configForms.get(SETTINGS_NS)
     * （落盘到 profile 的 cordis.patch.yml，跨窗口/跨会话/重启都不丢），
     * 服务端表单不可用时退回 localStorage。
     *
     * 快照形状统一为 { source, status, value, writable, message }，并保证
     * 未变化时返回**同一个对象引用**（useSyncExternalStore 要求）。
     */
    function createStore(form) {
      var listeners = []
      var cached = null
      var hostReady = false
      var lastError = ''

      function currentValue() {
        if (hostReady && form) {
          var snap = form.getSnapshot()
          if (snap && snap.status === 'ready' && snap.mode === 'host' && snap.writable) return snap.value
        }
        var local = readLocal()
        return local === null ? defaultConfig() : local
      }

      function build() {
        var source = 'local'
        var status = 'local'
        var writable = true
        var message = ''
        if (form) {
          var snap = form.getSnapshot()
          if (snap && snap.status === 'ready') {
            if (snap.mode === 'host' && snap.writable) {
              source = 'host'
              status = 'ready'
            } else {
              status = snap.writable ? 'memory' : 'readonly'
              message = snap.mode === 'host' ? '当前为只读' : '远端页面：价格表只能存在本浏览器'
            }
          } else if (snap && snap.status === 'unavailable') {
            status = 'unavailable'
            message = '服务端设置不可用，已退回本浏览器存储'
          } else {
            status = 'loading'
            message = '正在连接设置服务…'
          }
        }
        if (lastError) message = lastError
        return {
          source: source,
          status: status,
          writable: writable,
          message: message,
          value: sanitize(currentValue()),
        }
      }

      function emit() {
        cached = build()
        var list = listeners.slice()
        for (var i = 0; i < list.length; i++) {
          try { list[i]() } catch (err) { /* 订阅者异常不影响其它订阅者 */ }
        }
      }

      function refreshHost() {
        if (!form) return
        var snap = form.getSnapshot()
        hostReady = !!(snap && snap.status === 'ready' && snap.mode === 'host' && snap.writable)
        emit()
      }

      var offForm = null
      if (form) {
        onFormChange()
        try { offForm = form.subscribe(onFormChange) } catch (err) { offForm = null }
      }
      function onFormChange() {
        refreshHost()
      }
      cached = build()

      return {
        getSnapshot: function () {
          if (cached === null) cached = build()
          return cached
        },
        subscribe: function (listener) {
          listeners.push(listener)
          return function () {
            var i = listeners.indexOf(listener)
            if (i >= 0) listeners.splice(i, 1)
          }
        },
        /** 保存整份配置：逐字段写回（服务端 ConfigForm 以顶层字段为写入单位）。 */
        save: function (next) {
          var value = sanitize(next)
          lastError = ''
          if (hostReady && form) {
            var keys = ownKeys(value)
            var chain = Promise.resolve(true)
            for (var i = 0; i < keys.length; i++) {
              ;(function (key) {
                chain = chain.then(function (ok) {
                  if (ok === false) return false
                  return Promise.resolve(form.set(key, value[key])).then(function (result) {
                    return result === false ? false : true
                  })
                })
              })(keys[i])
            }
            return chain.then(function (ok) {
              if (ok === false) {
                lastError = '服务端拒绝了本次保存（配置可能不是 volatile 字段）'
                emit()
                return false
              }
              writeLocal(value)
              emit()
              return true
            }, function (err) {
              lastError = '保存失败：' + (err && err.message ? err.message : String(err))
              emit()
              return false
            })
          }
          writeLocal(value)
          emit()
          return Promise.resolve(true)
        },
        dispose: function () {
          if (offForm) { try { offForm() } catch (err) { /* ignore */ } offForm = null }
        },
      }
    }

    /**
     * 订阅 store 的 React hook（优先 useSyncExternalStore）。
     *
     * store 缺失时退化为一个恒定快照的空 store —— 关键是**无条件**调用 hook，
     * 否则 STORE 在挂载前后变化会打乱 hook 顺序（React 会直接报错）。
     */
    var EMPTY_SNAPSHOT = {
      source: 'local',
      status: 'unavailable',
      writable: false,
      message: '价格表存储不可用：设置服务未就绪。',
      value: null,
    }
    var NO_STORE = {
      getSnapshot: function () { return EMPTY_SNAPSHOT },
      subscribe: function () { return function () {} },
    }

    function useSnapshot(store) {
      var target = store || NO_STORE
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(
          React.useCallback(function (cb) { return target.subscribe(cb) }, [target]),
          React.useCallback(function () { return target.getSnapshot() }, [target]),
          React.useCallback(function () { return target.getSnapshot() }, [target]),
        )
      }
      var pair = React.useState(function () { return target.getSnapshot() })
      React.useEffect(function () {
        return target.subscribe(function () { pair[1](target.getSnapshot()) })
      }, [target])
      return pair[0]
    }

    /* ──────────────────────── 回合尾部金额行 ──────────────────────── */

    function CostTail(props) {
      var openPair = React.useState(false)
      var open = openPair[0]
      var setOpen = openPair[1]
      var store = STORE
      var snap = useSnapshot(store)
      var cfg = snap.value || defaultConfig()
      var tail = readTurnTail(props.turn)
      var usage = tail && tail.tokenUsage ? tail.tokenUsage : null

      if (!cfg.enabled || usage === null) return null
      var ms = toMs(tail.time)
      var result = computeCost(usage, cfg, ms)
      if (!result.ok) return null

      var clock = isFinite(ms) ? wallClock(ms, cfg.tzOffset) : null
      var badge = null
      if (result.rule !== null) {
        badge = h('span', {
          className: 'dtc-badge ' + (result.rule.kind === 'promo' ? 'dtc-badge-promo' : 'dtc-badge-peak'),
        }, result.rule.label + (result.rule.multiplier === 1 ? '' : '×' + result.rule.multiplier))
      }

      var chip = h('button', {
        type: 'button',
        className: 'dtc-chip',
        'aria-expanded': open,
        title: '本轮花费（点击查看明细）',
        onClick: function () { setOpen(!open) },
      },
        h('span', { className: 'dtc-sign' }, '本轮花费'),
        h('span', { className: 'dtc-amount' }, formatMoney(result.total, cfg)),
        badge,
        h('span', { className: 'dtc-caret' }, open ? '▲' : '▼'),
      )

      if (!open) return h('div', { className: 'dtc-row', 'data-turn-cost': props.seq }, chip)

      var rows = result.parts.map(function (part) {
        return h('tr', { key: part.key },
          h('td', null, part.label),
          h('td', { className: 'dtc-num' }, formatTokens(part.tokens)),
          h('td', { className: 'dtc-num' }, formatMoney(part.unit, cfg)),
          h('td', { className: 'dtc-num' }, formatMoney(part.amount, cfg)),
        )
      })

      var meta = []
      meta.push(h('div', { key: 'model' },
        '模型：' + (result.route ? (result.route.provider ? result.route.provider + ' / ' : '') + result.route.model : '未知')
          + (result.routes.length > 1 ? '（本轮共 ' + result.routes.length + ' 个路由，按末次尝试计价）' : '')))
      if (clock !== null) meta.push(h('div', { key: 'time' }, '计费时刻：' + clock.ymd + ' ' + clock.hm + '（UTC' + (cfg.tzOffset >= 0 ? '+' : '') + cfg.tzOffset + '，' + clock.dayName + '）'))
      meta.push(h('div', { key: 'rule' },
        '生效价格：' + (result.rule === null
          ? '基础价（' + (result.entry.label || result.entry.model) + '）'
          : result.rule.label + ' ×' + result.rule.multiplier + (result.rule.detail ? '（' + result.rule.detail + '）' : ''))))
      meta.push(h('div', { key: 'unit' }, '单价口径：每 ' + formatTokens(cfg.perTokens) + ' tokens'))

      return h('div', { className: 'dtc-row', 'data-turn-cost': props.seq },
        chip,
        h('div', { className: 'dtc-panel' },
          h('div', { className: 'dtc-panel-title' },
            h('span', null, '本轮花费明细'),
            h('span', { className: 'dtc-amount' }, formatMoney(result.total, cfg))),
          h('div', { className: 'dtc-meta' }, meta),
          h('table', { className: 'dtc-table' },
            h('thead', null, h('tr', null,
              h('th', null, '类别'),
              h('th', { className: 'dtc-num' }, 'tokens'),
              h('th', { className: 'dtc-num' }, '单价'),
              h('th', { className: 'dtc-num' }, '金额'))),
            h('tbody', null, rows)),
          h('div', { className: 'dtc-total' },
            h('span', null, '合计'),
            h('span', null, formatMoney(result.total, cfg))),
          h('div', { className: 'dtc-hint' },
            '金额按当前价格表实时计算；修改设置里的价格后，所有回合的金额会立即更新。'),
        ))
    }

    /* ──────────────────────── 设置页 ──────────────────────── */

    function Field(props) {
      return h('label', { className: 'dtc-field' },
        h('span', { className: 'dtc-field-label' }, props.label),
        props.children)
    }

    function NumberInput(props) {
      return h('input', {
        className: 'dtc-input' + (props.wide ? ' dtc-input-wide' : '') + (props.full ? ' dtc-input-full' : ''),
        type: 'number',
        step: props.step === undefined ? 'any' : props.step,
        min: props.min,
        value: props.value,
        placeholder: props.placeholder,
        disabled: props.disabled,
        onChange: function (event) { props.onChange(event.target.value) },
      })
    }

    function TextInput(props) {
      return h('input', {
        className: 'dtc-input' + (props.wide ? ' dtc-input-wide' : '') + (props.full ? ' dtc-input-full' : ''),
        type: 'text',
        value: props.value,
        placeholder: props.placeholder,
        disabled: props.disabled,
        onChange: function (event) { props.onChange(event.target.value) },
      })
    }

    function DaysPicker(props) {
      return h('div', { className: 'dtc-days' }, DAY_ORDER.map(function (day) {
        var on = props.days.indexOf(day) >= 0
        return h('span', {
          key: day,
          className: 'dtc-day' + (on ? ' dtc-day-on' : ''),
          role: 'checkbox',
          'aria-checked': on,
          onClick: function () {
            if (props.disabled) return
            var next = props.days.slice()
            var i = next.indexOf(day)
            if (i >= 0) next.splice(i, 1)
            else next.push(day)
            props.onChange(next.length ? next : [day])
          },
        }, DAY_NAMES[day])
      }))
    }

    /** 一个模型条目：基础价 / 峰谷规则 / 限时特价 / 当前生效价预览。 */
    function ModelEditor(props) {
      var m = props.model
      var cfg = props.cfg
      var disabled = props.disabled
      var edit = props.onEdit

      function setPrice(key, text) {
        var patch = {}
        patch[key] = text === '' ? 0 : num(text, 0)
        edit(patch)
      }
      function setRule(index, patch) {
        var rules = m.rules.slice()
        rules[index] = Object.assign({}, rules[index], patch)
        edit({ rules: rules })
      }
      function setPromo(index, patch) {
        var promos = m.promos.slice()
        promos[index] = Object.assign({}, promos[index], patch)
        edit({ promos: promos })
      }

      /* 当前时刻的生效价预览：直接回答「现在到底按哪个价算」。 */
      var now = Date.now()
      var resolved = resolveUnitPrices(m, now, cfg)
      var clock = wallClock(now, cfg.tzOffset)
      var preview = PRICE_KEYS.map(function (key) {
        return PRICE_LABELS[key] + ' ' + formatMoney(resolved.unit[key], cfg)
      }).join(' ｜ ')

      return h('div', { className: 'dtc-card' },
        h('div', { className: 'dtc-grid' },
          h(Field, { label: '模型 id' },
            h(TextInput, { value: m.model, wide: true, disabled: disabled, placeholder: 'deepseek-flash', onChange: function (v) { edit({ model: v }) } })),
          h(Field, { label: '提供方' },
            h(TextInput, { value: m.provider, wide: true, disabled: disabled, placeholder: '留空=不限', onChange: function (v) { edit({ provider: v }) } })),
          h(Field, { label: '显示名' },
            h(TextInput, { value: m.label, wide: true, disabled: disabled, placeholder: '留空=用模型 id', onChange: function (v) { edit({ label: v }) } })),
        ),

        h('div', { className: 'dtc-note' }, '基础价 = 空闲时段价（每 ' + formatTokens(cfg.perTokens) + ' tokens 的金额）。'),
        h('div', { className: 'dtc-grid' },
          h(Field, { label: PRICE_LABELS.input }, h(NumberInput, { value: m.input, disabled: disabled, onChange: function (v) { setPrice('input', v) } })),
          h(Field, { label: PRICE_LABELS.cacheRead }, h(NumberInput, { value: m.cacheRead, disabled: disabled, onChange: function (v) { setPrice('cacheRead', v) } })),
          h(Field, { label: PRICE_LABELS.cacheWrite }, h(NumberInput, { value: m.cacheWrite, disabled: disabled, onChange: function (v) { setPrice('cacheWrite', v) } })),
          h(Field, { label: PRICE_LABELS.output }, h(NumberInput, { value: m.output, disabled: disabled, onChange: function (v) { setPrice('output', v) } })),
        ),

        h('div', { className: 'dtc-sub' },
          h('div', { className: 'dtc-sub-head' },
            h('span', null, '峰谷规则（一周内循环时段，价格 × 系数）'),
            h('button', {
              type: 'button', className: 'dtc-btn', disabled: disabled,
              onClick: function () { edit({ rules: m.rules.concat([{ label: '高峰', days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00', multiplier: 2 }]) }) },
            }, '+ 添加规则')),
          m.rules.length === 0 ? h('div', { className: 'dtc-note' }, '无规则：全天按基础价。') : null,
          m.rules.map(function (rule, index) {
            return h('div', { key: index, className: 'dtc-inline' },
              h(TextInput, { value: rule.label, wide: true, disabled: disabled, placeholder: '名称', onChange: function (v) { setRule(index, { label: v }) } }),
              h(DaysPicker, { days: rule.days, disabled: disabled, onChange: function (v) { setRule(index, { days: v }) } }),
              h(TextInput, { value: rule.start, disabled: disabled, placeholder: '09:00', onChange: function (v) { setRule(index, { start: v }) } }),
              h('span', null, '–'),
              h(TextInput, { value: rule.end, disabled: disabled, placeholder: '12:00', onChange: function (v) { setRule(index, { end: v }) } }),
              h('span', null, '×'),
              h(NumberInput, { value: rule.multiplier, disabled: disabled, onChange: function (v) { setRule(index, { multiplier: v === '' ? 1 : num(v, 1) }) } }),
              h('button', {
                type: 'button', className: 'dtc-btn', disabled: disabled,
                onClick: function () { var next = m.rules.slice(); next.splice(index, 1); edit({ rules: next }) },
              }, '删除'),
            )
          }),
        ),

        h('div', { className: 'dtc-sub' },
          h('div', { className: 'dtc-sub-head' },
            h('span', null, '限时特价（绝对时间区间，优先级最高；区间内自成一套价格，不叠加峰谷）'),
            h('button', {
              type: 'button', className: 'dtc-btn', disabled: disabled,
              onClick: function () { edit({ promos: m.promos.concat([{ label: '限时优惠', from: '', to: '', multiplier: 1, input: -1, cacheRead: -1, cacheWrite: -1, output: -1 }]) }) },
            }, '+ 添加特价')),
          m.promos.length === 0 ? h('div', { className: 'dtc-note' }, '无特价：按基础价与峰谷规则计算。') : null,
          m.promos.map(function (promo, index) {
            return h('div', { key: index, className: 'dtc-card' },
              h('div', { className: 'dtc-inline' },
                h(TextInput, { value: promo.label, wide: true, disabled: disabled, placeholder: '名称', onChange: function (v) { setPromo(index, { label: v }) } }),
                h(TextInput, { value: promo.from, wide: true, disabled: disabled, placeholder: '2026-03-01T00:00', onChange: function (v) { setPromo(index, { from: v }) } }),
                h('span', null, '~'),
                h(TextInput, { value: promo.to, wide: true, disabled: disabled, placeholder: '2026-03-15T23:59', onChange: function (v) { setPromo(index, { to: v }) } }),
                h('button', {
                  type: 'button', className: 'dtc-btn', disabled: disabled,
                  onClick: function () { var next = m.promos.slice(); next.splice(index, 1); edit({ promos: next }) },
                }, '删除'),
              ),
              h('div', { className: 'dtc-inline' },
                h('span', null, '系数 ×'),
                h(NumberInput, { value: promo.multiplier, disabled: disabled, onChange: function (v) { setPromo(index, { multiplier: v === '' ? 1 : num(v, 1) }) } }),
                h('span', { className: 'dtc-note' }, '留空 = 基础价 × 上面的系数（不单独覆盖）'),
              ),
              h('div', { className: 'dtc-grid' }, PRICE_KEYS.map(function (key) {
                return h(Field, { key: key, label: PRICE_LABELS[key] },
                  h(NumberInput, {
                    value: promo[key] >= 0 ? promo[key] : '',
                    disabled: disabled,
                    placeholder: '不覆盖',
                    onChange: function (v) { var patch = {}; patch[key] = v === '' ? -1 : num(v, -1); setPromo(index, patch) },
                  }))
              })),
            )
          }),
        ),

        h('div', { className: 'dtc-preview' },
          '现在（UTC' + (cfg.tzOffset >= 0 ? '+' : '') + cfg.tzOffset + ' ' + clock.dayName + ' ' + clock.hm + '）生效单价：' + preview
            + (resolved.rule === null ? '（基础价）' : '（' + resolved.rule.label + ' ×' + resolved.rule.multiplier + '）')),
        h('div', { className: 'dtc-actions' },
          h('button', {
            type: 'button', className: 'dtc-btn', disabled: disabled,
            onClick: function () { props.onRemove() },
          }, '删除该模型'),
        ),
      )
    }

    function PriceSection(props) {
      var store = STORE
      var snap = useSnapshot(store)
      var cfg = snap.value || defaultConfig()
      var draftPair = React.useState(null)
      var draft = draftPair[0]
      var setDraft = draftPair[1]
      var tabPair = React.useState(0)
      var tab = tabPair[0]
      var setTab = tabPair[1]
      var statusPair = React.useState({ text: '', kind: '' })
      var status = statusPair[0]
      var setStatus = statusPair[1]

      var current = draft === null ? cfg : draft
      var dirty = draft !== null

      function edit(patch) {
        setDraft(Object.assign({}, current, patch))
        setStatus({ text: '', kind: '' })
      }
      function editModel(index, patch) {
        var models = current.models.slice()
        models[index] = Object.assign({}, models[index], patch)
        edit({ models: models })
      }

      var models = current.models
      var active = Math.min(tab, Math.max(0, models.length - 1))
      var activeModel = models.length ? models[active] : null

      function save() {
        setStatus({ text: '保存中…', kind: '' })
        return store.save(current).then(function (ok) {
          if (ok) {
            setDraft(null)
            setStatus({ text: '已保存，所有回合的金额已按新价格更新。', kind: 'dtc-ok' })
          } else {
            setStatus({ text: '保存失败：' + (store.getSnapshot().message || '未知原因'), kind: 'dtc-err' })
          }
        })
      }

      return h('div', { className: 'dtc-page' },
        h('div', { className: 'dtc-sec' },
          h('div', { className: 'dtc-sec-title' }, '每轮花费'),
          h('div', { className: 'dtc-note' },
            '在每个已完成回合的下方显示这一轮的花费金额。金额按下面这份价格表**实时计算**：'
            + 'token 用量来自 DSH 内置的「本轮用量」（不会改动或估算），所以你事后修改价格，'
            + '所有历史回合的金额会立刻跟着更正。'),
          snap.message ? h('div', { className: 'dtc-status dtc-warn' }, snap.message) : null,
        ),

        h('div', { className: 'dtc-sec' },
          h('div', { className: 'dtc-grid' },
            h('label', { className: 'dtc-check' },
              h('input', {
                type: 'checkbox', checked: current.enabled, disabled: !snap.writable,
                onChange: function (e) { edit({ enabled: e.target.checked }) },
              }),
              '显示每轮花费'),
            h(Field, { label: '货币符号' },
              h(TextInput, { value: current.currency, disabled: !snap.writable, onChange: function (v) { edit({ currency: v }) } })),
            h(Field, { label: '小数位' },
              h(NumberInput, { step: '1', min: '0', value: current.decimals, disabled: !snap.writable, onChange: function (v) { edit({ decimals: v === '' ? 4 : Math.round(num(v, 4)) }) } })),
            h(Field, { label: '时区偏移' },
              h(NumberInput, { step: '0.5', value: current.tzOffset, disabled: !snap.writable, onChange: function (v) { edit({ tzOffset: v === '' ? 8 : num(v, 8) }) } })),
            h(Field, { label: '每多少 tokens' },
              h(NumberInput, { step: '1', value: current.perTokens, disabled: !snap.writable, onChange: function (v) { edit({ perTokens: v === '' ? 1000000 : num(v, 1000000) }) } })),
            h(Field, { label: '未配置的模型' },
              h('select', {
                className: 'dtc-input dtc-input-wide', value: current.unknownModel, disabled: !snap.writable,
                onChange: function (e) { edit({ unknownModel: e.target.value }) },
              },
                h('option', { value: 'hide' }, '不显示金额'),
                h('option', { value: 'fallback' }, '用兜底价计算'))),
          ),
          current.unknownModel === 'fallback' ? h('div', { className: 'dtc-grid' },
            h(Field, { label: '兜底 ' + PRICE_LABELS.input }, h(NumberInput, { value: current.fallback.input, disabled: !snap.writable, onChange: function (v) { edit({ fallback: Object.assign({}, current.fallback, { input: num(v, 0) }) }) } })),
            h(Field, { label: '兜底 ' + PRICE_LABELS.cacheRead }, h(NumberInput, { value: current.fallback.cacheRead, disabled: !snap.writable, onChange: function (v) { edit({ fallback: Object.assign({}, current.fallback, { cacheRead: num(v, 0) }) }) } })),
            h(Field, { label: '兜底 ' + PRICE_LABELS.cacheWrite }, h(NumberInput, { value: current.fallback.cacheWrite, disabled: !snap.writable, onChange: function (v) { edit({ fallback: Object.assign({}, current.fallback, { cacheWrite: num(v, 0) }) }) } })),
            h(Field, { label: '兜底 ' + PRICE_LABELS.output }, h(NumberInput, { value: current.fallback.output, disabled: !snap.writable, onChange: function (v) { edit({ fallback: Object.assign({}, current.fallback, { output: num(v, 0) }) }) } })),
          ) : null,
        ),

        h('div', { className: 'dtc-sec' },
          h('div', { className: 'dtc-sub-head' },
            h('span', { className: 'dtc-sec-title' }, '模型价格'),
            h('button', {
              type: 'button', className: 'dtc-btn', disabled: !snap.writable,
              onClick: function () {
                var next = models.concat([{ model: '', provider: '', label: '', input: 0, cacheRead: 0, cacheWrite: 0, output: 0, rules: [], promos: [] }])
                edit({ models: next })
                setTab(next.length - 1)
              },
            }, '+ 添加模型'),
          ),
          h('div', { className: 'dtc-tabs' }, models.map(function (m, index) {
            return h('button', {
              key: index,
              type: 'button',
              className: 'dtc-tab' + (index === active ? ' dtc-tab-active' : ''),
              onClick: function () { setTab(index) },
            }, (m.label || m.model || '未命名') + (index === active && dirty ? ' •' : ''))
          })),
          activeModel === null
            ? h('div', { className: 'dtc-note' }, '价格表为空：点「+ 添加模型」开始配置，或恢复 DeepSeek 官方价。')
            : h(ModelEditor, {
                model: activeModel,
                cfg: current,
                disabled: !snap.writable,
                onEdit: function (patch) { editModel(active, patch) },
                onRemove: function () {
                  var next = models.slice()
                  next.splice(active, 1)
                  edit({ models: next })
                  setTab(Math.max(0, active - 1))
                },
              }),
        ),

        h('div', { className: 'dtc-actions' },
          h('button', {
            type: 'button', className: 'dtc-btn dtc-btn-primary', disabled: !snap.writable || !dirty,
            onClick: save,
          }, dirty ? '保存价格表' : '已保存'),
          h('button', {
            type: 'button', className: 'dtc-btn', disabled: !dirty,
            onClick: function () { setDraft(null); setStatus({ text: '已放弃未保存的修改。', kind: '' }) },
          }, '放弃修改'),
          h('span', { className: 'dtc-spacer' }),
          h('button', {
            type: 'button', className: 'dtc-btn', disabled: !snap.writable,
            onClick: function () {
              if (!window.confirm('用 DeepSeek 官方价格覆盖当前价格表？（deepseek-flash 与 deepseek-v4-pro，空闲时段价为基础价，高峰 ×2）')) return
              edit({
                models: [
                  deepseekModel('deepseek-flash', 'DeepSeek Flash', 1, 0.02, 4),
                  deepseekModel('deepseek-v4-pro', 'DeepSeek V4 Pro', 4.5, 0.15, 13.5),
                ],
              })
              setTab(0)
            },
          }, '恢复 DeepSeek 官方价'),
          h('span', { className: 'dtc-status ' + status.kind }, status.text),
        ),
        h('div', { className: 'dtc-note' },
          '峰谷规则按「一周内循环时段」判定，时区用上面的时区偏移（默认 +8 北京时间）；'
          + 'DeepSeek 官方口径是周一至周五 09:00–12:00、14:00–18:00 为高峰，其余（含周末与法定节假日）为空闲，'
          + '空闲价 = 高峰价的一半，所以基础价填**空闲价**、规则填 ×2；'
          + '法定节假日全天可用「限时特价」把区间乘数设为 1（或直接写覆盖价）来单独处理。'),
      )
    }

    /* ──────────────────────── 装配 ──────────────────────── */

    /**
     * 只硬依赖 slots —— configForms 用 ctx.get 取（取不到就退回 localStorage），
     * 这样设置服务缺失时金额显示仍然可用（inject 缺失会让整个 fiber 停在 pending）。
     */
    var inject = ['slots']

    /** 模块级 store：组件与 apply 共享同一个实例。 */
    var STORE = null

    function apply(ctx) {
      var form = null
      try {
        var forms = typeof ctx.get === 'function' ? ctx.get('configForms') : null
        if (forms && typeof forms.get === 'function') form = forms.get(SETTINGS_NS)
      } catch (err) {
        form = null
      }
      var store = createStore(form)
      STORE = store
      ctx.effect(function () {
        return function () {
          store.dispose()
          /* 注意：不要 dispose form —— ctx.configForms.get(entryId) 是共享的
             memoized 对象，生命周期归 dsh-client-ui-settings 的 provider 所有。 */
          if (STORE === store) STORE = null
        }
      }, 'turn-cost: store')

      ctx.slots.inject('conversation.chat.turnTail', function () {
        return ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'turn-cost',
          /* 排在其它尾部贡献之后，尽量贴近操作行 */
          order: 100,
        }, CostTail)
      })

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'turn-cost',
          order: 30,
          label: function () { return '每轮花费' },
        }, function Section() { return h(PriceSection, null) })
      })
    }

    exports.apply = apply
    exports.inject = inject
    /**
     * 供离线单元测试使用的内部函数（浏览器侧不会被读取）。
     * tools/test-pricing.mjs 通过它验证峰谷/特价/时区/跨零点等纯计算逻辑。
     */
    exports.__internals = {
      SETTINGS_NS: SETTINGS_NS,
      defaultConfig: defaultConfig,
      sanitize: sanitize,
      sanitizeModel: sanitizeModel,
      parseHM: parseHM,
      parseWall: parseWall,
      wallClock: wallClock,
      ruleMatches: ruleMatches,
      promoMatches: promoMatches,
      resolveUnitPrices: resolveUnitPrices,
      findEntry: findEntry,
      computeCost: computeCost,
      formatMoney: formatMoney,
      toMs: toMs,
      readTurnTail: readTurnTail,
      deepseekModel: deepseekModel,
    }
    return module.exports
  },
})
