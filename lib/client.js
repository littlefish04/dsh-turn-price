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
     *
     * ⚠️ **查证过（2026-10-06），别"顺手"改成 `include:turn-cost`**：
     *   · Host `dsh-settings` 的 `describe()` 用 `entry.options.id` 当 ns
     *     （`dsh-settings/lib/index.js:432`）—— 那是**裸 id**；
     *   · Inspect / 插件管理器里显示的 `include:turn-cost` 是 cordis-loader 的
     *     `Entry.id`（`Entry.id = 父级 id + ':' + options.id`），**只用于 loader 查表**，
     *     不是设置命名空间。
     * 两边漂移的后果是**静默的**：`configForms.get()` 拿不到表单 → 退回 localStorage
     * → 用户填的余额来源永远到不了宿主，汇总行余额恒为 —。
     * `tools/test-settings-form.mjs` 会拿这个常量与 cordis.patch.yml 的 id 直接比对。
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
      /* ── 汇总行（conversation.composer.dock，order -10）──────────────────
         位置：输入框下方、内置「性能与用量」行上方。
         字号与内置 stats 行同档（12px），整行 flex-wrap 以便窄窗口折行。
         配色纪律同前：只用 --dsw-alias-*，不写兜底值。 */
      '.dtc-sum{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;',
      'font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);',
      'margin:2px 0 0;color-scheme:light;}',
      'body[data-ds-dark-theme] .dtc-sum{color-scheme:dark;}',
      '.dtc-sum-seg{display:inline-flex;align-items:center;gap:4px;cursor:pointer;user-select:none;',
      'border:0;background:transparent;font:inherit;color:inherit;padding:1px 3px;',
      'border-radius:var(--dsw-radius-xs);}',
      '.dtc-sum-seg:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dtc-sum-seg[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-active);',
      'color:var(--dsw-alias-label-primary);}',
      '.dtc-sum-label{opacity:.85;}',
      '.dtc-sum-amount{font-variant-numeric:tabular-nums;font-weight:600;',
      'color:var(--dsw-alias-label-primary);}',
      '.dtc-sum-missing{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);}',
      '.dtc-sum-sep{color:var(--dsw-alias-label-tertiary);}',
      '.dtc-sum-updated{font-size:11px;color:var(--dsw-alias-label-tertiary);',
      'border:0;background:transparent;font-family:inherit;cursor:pointer;padding:0;}',
      '.dtc-sum-updated:hover{color:var(--dsw-alias-label-secondary);}',
      /* 汇总行的明细面板：比轮尾的窄一点，因为它挂在输入框下方。
         ⚠️ **必须限制高度并内部滚动**（用户 2026-10-05 反馈）：早期只限了 `max-width`，
         内容一长面板就无限撑高，把整个输入区推下去、连对话都看不见，还会干扰会话区滚动。
         现在：面板最高 `min(46vh, 380px)`，头部与脚注固定，**只有中间正文滚动**
         （`overflow:auto` + `min-height:0`，flex 子项要能收缩必须显式给 min-height）。 */
      '.dtc-sum-panel{flex-basis:100%;max-width:560px;max-height:min(46vh,380px);',
      'display:flex;flex-direction:column;gap:6px;overflow:hidden;',
      'border-radius:var(--dsw-radius-lg);padding:9px 11px;',
      '--dsw-elevation-stroke-color:var(--dsw-alias-border-l2);',
      'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);',
      'box-shadow:var(--dsw-elevation-panel);color-scheme:light;}',
      'body[data-ds-dark-theme] .dtc-sum-panel{color-scheme:dark;}',
      /* 正文滚动区：`min-height:0` 是让 flex 子项能真正收缩的关键，漏了就还是会撑高。 */
      '.dtc-sum-panel-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;',
      'display:flex;flex-direction:column;gap:6px;padding-right:2px;}',
      '.dtc-sum-panel-title{display:flex;justify-content:space-between;gap:10px;font-size:12px;',
      'font-weight:600;color:var(--dsw-alias-label-primary);flex:0 0 auto;}',
      /* ── 设置页顶部横栏（2026-10-05 用户要求：4 个选项卡横向切换）──────────
         用语义变量 + 不写兜底值；选中项靠 label-primary + 加粗 + 下划线三重区分，
         不只靠颜色（色盲友好）。 */
      '.dtc-tabbar{display:flex;flex-wrap:wrap;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l2);',
      'margin:2px 0 12px;}',
      '.dtc-tabbar-item{font:inherit;font-size:13px;cursor:pointer;padding:7px 14px;border:0;',
      'background:transparent;color:var(--dsw-alias-label-secondary);border-bottom:2px solid transparent;',
      'margin-bottom:-1px;border-radius:var(--dsw-radius-xs) var(--dsw-radius-xs) 0 0;}',
      '.dtc-tabbar-item:hover{background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-primary);}',
      '.dtc-tabbar-active{color:var(--dsw-alias-label-primary);font-weight:600;',
      'border-bottom-color:var(--dsw-alias-label-primary);}',
      /* 选项卡之间的分隔：靠上边框 + 内边距，让相邻卡片不再糊在一起。 */
      '.dtc-pane{border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px;}',
      '.dtc-pane .dtc-sec + .dtc-sec{border-top:1px solid var(--dsw-alias-border-l1);margin-top:14px;padding-top:14px;}',
      /* 选项卡标题行 + 右上角的保存动作。
         ⚠️ 不要做成 sticky 黑条：用户明确反馈「按钮在黑条上、高度不居中，很丑」。
         这里就是普通行内容器，`align-items:center` 保证按钮与标题垂直居中对齐。 */
      '.dtc-pane-head{display:flex;align-items:center;gap:10px;margin:0 0 10px;min-height:30px;}',
      '.dtc-pane-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.dtc-pane-actions{display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap;',
      'justify-content:flex-end;}',
      /* ── 消费日历（用户要求：一格一天，颜色越深花得越多）──────────────
         颜色分级只用语义变量：0 元用 layer-2（有观测但没花钱），
         无观测用透明 + 虚线边（必须与 0 元区分，决策 #7）。 */
      '.dtc-cal{display:flex;flex-direction:column;gap:8px;}',
      '.dtc-cal-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.dtc-cal-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);',
      'font-variant-numeric:tabular-nums;}',
      '.dtc-cal-nav{font:inherit;font-size:12px;cursor:pointer;padding:3px 9px;border-radius:var(--dsw-radius-sm);',
      'border:1px solid var(--dsw-alias-border-l2);background:transparent;',
      'color:var(--dsw-alias-label-secondary);}',
      '.dtc-cal-nav:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-primary);}',
      '.dtc-cal-nav:disabled{opacity:.4;cursor:default;}',
      '.dtc-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;}',
      '.dtc-cal-dow{text-align:center;font-size:11px;color:var(--dsw-alias-label-tertiary);padding:2px 0;}',
      '.dtc-cal-cell{position:relative;aspect-ratio:1/1;min-height:34px;border-radius:var(--dsw-radius-sm);',
      'border:1px solid transparent;background:transparent;cursor:pointer;padding:3px 4px;',
      'display:flex;flex-direction:column;justify-content:space-between;align-items:flex-start;',
      'font:inherit;color:var(--dsw-alias-label-primary);color-scheme:light;}',
      'body[data-ds-dark-theme] .dtc-cal-cell{color-scheme:dark;}',
      '.dtc-cal-cell:hover{border-color:var(--dsw-alias-border-l2);}',
      '.dtc-cal-empty{visibility:hidden;cursor:default;}',
      /* 未来日期：不可点，淡显 */
      '.dtc-cal-future{opacity:.35;cursor:default;}',
      /* 没有观测：虚线边 + 透明底 —— 与「消费 0 元」（有实底）一眼可分 */
      '.dtc-cal-missing{border-style:dashed;border-color:var(--dsw-alias-border-l2);}',
      /* ── 消费日历的深浅层级 ──────────────────────────────────────────
         ⚠️ 两条硬约束（都是实测出来的，别只凭感觉调）：
         ① **不能**用 `--dsw-alias-label-tertiary` 之类的文字色当底色 ——
            实测（tools/calendar-contrast.mjs）深色主题下正文对比度只有 **2.04:1**，
            远低于 WCAG AA 的 4.5:1，就是用户以前反馈过的「深色下浅字浅底糊成一片」。
         ② 档位之间要能看出差别，但**深色下正文对比度与档位跨度直接冲突**：
            深色最深的档只要超过 ~38%，正文对比度就跌破 4.5:1。
         所以采用「**用前景色 `--dsw-alias-label-primary` 做 alpha 混合 + 按主题给不同百分比**」：
         同一个变量随主题变化，两边都能各取所需 —— 浅色跨度大（4/13/26/40/55%），
         深色受对比度限制收窄（4/11/20/29/38%）。
         两套百分比都经 `tools/calendar-contrast.mjs` 核算：正文对比度 ≥4.5:1 且相邻档 ≥1.15:1。
         `--dsw-dtc-cal-*` 是**本插件自己**的变量（不是 DSH 主题变量），集中在此便于核算与调整。 */
      ':root{--dsw-dtc-cal-base:var(--dsw-alias-label-primary);}',
      ':root{--dsw-dtc-cal-zero:4%;--dsw-dtc-cal-1:13%;--dsw-dtc-cal-2:26%;--dsw-dtc-cal-3:40%;--dsw-dtc-cal-4:55%;}',
      'body[data-ds-dark-theme]{--dsw-dtc-cal-zero:4%;--dsw-dtc-cal-1:11%;--dsw-dtc-cal-2:20%;--dsw-dtc-cal-3:29%;--dsw-dtc-cal-4:38%;}',
      '.dtc-cal-l0{background:transparent;}',
      '.dtc-cal-l1{background:color-mix(in srgb, var(--dsw-dtc-cal-base) var(--dsw-dtc-cal-1), transparent);}',
      '.dtc-cal-l2{background:color-mix(in srgb, var(--dsw-dtc-cal-base) var(--dsw-dtc-cal-2), transparent);}',
      '.dtc-cal-l3{background:color-mix(in srgb, var(--dsw-dtc-cal-base) var(--dsw-dtc-cal-3), transparent);}',
      '.dtc-cal-l4{background:color-mix(in srgb, var(--dsw-dtc-cal-base) var(--dsw-dtc-cal-4), transparent);}',
      /* 消费 0 元：有观测但没花钱 —— 最浅一档实底，与「无观测」的虚线空底区分（决策 #7）。 */
      '.dtc-cal-zero{background:color-mix(in srgb, var(--dsw-dtc-cal-base) var(--dsw-dtc-cal-zero), transparent);}',
      /* 今天：单独强调色 —— 用主色描边 + 加粗，不靠填充色深浅 */
      '.dtc-cal-today{border:2px solid var(--dsw-alias-label-primary);font-weight:700;}',
      '.dtc-cal-selected{outline:2px solid var(--dsw-alias-button-primary-fill);outline-offset:1px;}',
      '.dtc-cal-day{font-size:11px;line-height:13px;font-variant-numeric:tabular-nums;}',
      '.dtc-cal-amt{font-size:10px;line-height:12px;opacity:.9;font-variant-numeric:tabular-nums;}',
      '.dtc-cal-flag{position:absolute;top:2px;right:3px;font-size:9px;line-height:9px;}',
      '.dtc-cal-legend{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;',
      'color:var(--dsw-alias-label-tertiary);}',
      '.dtc-cal-swatch{width:12px;height:12px;border-radius:3px;display:inline-block;',
      'border:1px solid var(--dsw-alias-border-l1);}',
      '.dtc-cal-detail{border-radius:var(--dsw-radius-lg);padding:10px 12px;',
      'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);',
      'display:flex;flex-direction:column;gap:6px;}',
      '.dtc-cal-detail-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);',
      'font-variant-numeric:tabular-nums;}',
    ].join('\n')
    /**
     * 样式版本：改了上面的 CSS 就 +1。
     * 只按「有没有同 id 的 <style>」去重的话，插件热重载时旧节点会挡住新样式，
     * 表现为「改完代码界面没变」，所以这里带版本号并清掉旧节点。
     *
     * ⚠️ `CSS_HASH` 是上面那段 CSS 文本的 sha256 前 12 位，**和版本号成对更新**：
     * `tools/test-theme-tokens.mjs` 会重算哈希并与它比对 —— 改了 CSS 却忘了 bump
     * 版本号时测试会直接失败（那个症状「改完界面没变」极难自查，所以必须有守卫）。
     * 改了 CSS 的正确流程：先把 `CSS_VERSION` +1，再把新哈希填到 `CSS_HASH`
     * （测试失败信息里会直接给出应有的哈希值）。
     */
    var CSS_VERSION = '4'
    var CSS_HASH = '72517b9689c0'
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

    /** 汇总行 5 段的标识与默认顺序（与 lib/index.js 的 DISPLAY_KEYS 一致）。 */
    var DISPLAY_KEYS = ['balance', 'month', 'todayReal', 'todayEstimate', 'sessionTotal']
    var DISPLAY_LABELS = {
      balance: '余额',
      month: '本月',
      todayReal: '今日',
      todayEstimate: '今日',
      sessionTotal: '会话',
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
        /* 与 lib/index.js 的 Config 默认值逐项一致（AGENTS §3 铁律 7）。 */
        balanceSources: [],
        balanceRefreshSeconds: 300,
        balanceTimeoutMs: 8000,
        ledgerRetentionMonths: 12,
        monthStartDay: 1,
        displayItems: { balance: true, month: true, todayReal: true, todayEstimate: true, sessionTotal: true },
        displayOrder: DISPLAY_KEYS.slice(),
        summaryDecimals: 2,
        showUpdatedAt: true,
        estimateBadgeText: '估算',
        incompleteBadgeText: '数据不完整',
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

    /**
     * 把值变成「墙上时间」文本（`YYYY-MM-DDTHH:mm`）。
     *
     * ⚠️ 为什么需要它（2026-10-05 事故的另一半）：`cordis.patch.yml` 是 YAML，
     * **未加引号**的 `from: 2026-10-01` 会被解析成 **Date 对象**。宿主侧的 Config
     * 已经把 Date 归一成字符串（`lib/index.js` 的 `yamlDateText`），但客户端这一层
     * 是**兜底**：一旦拿到 Date，`str()` 会返回 `''`，而 `''` 在这套语义里表示
     * 「该端不设限」—— 于是一条本该限时的特价会**静默变成永久生效**，改价看起来"没生效"。
     * 宁可在这里显式转换，也不要把 Date 变成空串。
     */
    function dateText(value, fallback) {
      if (value instanceof Date && !Number.isNaN(value.getTime())) {
        function p(n) { return String(n).length < 2 ? '0' + n : String(n) }
        /* 与 lib/index.js 的 yamlDateText 保持同一套规则：恰好落在日界（时分秒都=0）
           的 Date 按 **UTC 日历日 + 本地 0 点** 输出。js-yaml 把未加引号的 `2026-10-01`
           解析成 UTC 零点，天真地用本地 getter 会在东八区变成 08:00，特价窗口整体偏 8 小时。 */
        var dayBoundary = value.getUTCHours() === 0 && value.getUTCMinutes() === 0
          && value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0
        var y = dayBoundary ? value.getUTCFullYear() : value.getFullYear()
        var mo = dayBoundary ? value.getUTCMonth() : value.getMonth()
        var d = dayBoundary ? value.getUTCDate() : value.getDate()
        var h = dayBoundary ? 0 : value.getHours()
        var mi = dayBoundary ? 0 : value.getMinutes()
        return y + '-' + p(mo + 1) + '-' + p(d) + 'T' + p(h) + ':' + p(mi)
      }
      return str(value, fallback)
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
        /* 用 dateText 而不是 str：YAML 未加引号的日期是 Date，落到 str() 会变 ''，
           而 '' = 「该端不设限」，会让限时特价变成永久生效（静默错）。 */
        from: dateText(p.from, ''),
        to: dateText(p.to, ''),
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

    /** 夹取数字到 [min, max]，非数字回落 fallback。 */
    function clamped(value, fallback, min, max) {
      var n = num(value, fallback)
      if (!isFinite(n)) n = fallback
      return Math.max(min, Math.min(max, n))
    }

    /** 一个余额来源的净化（密钥不在这里：它走 ctx.credentials）。 */
    function sanitizeBalanceSource(raw) {
      var s = plain(raw) || {}
      var ids = Array.isArray(s.providerIds)
        ? s.providerIds.map(function (v) { return str(v, '').trim() }).filter(function (v) { return v !== '' })
        : []
      return {
        id: str(s.id, ''),
        label: str(s.label, ''),
        adapter: str(s.adapter, 'none') || 'none',
        providerIds: ids,
        credentialRef: str(s.credentialRef, ''),
        baseUrl: str(s.baseUrl, ''),
        enabled: bool(s.enabled, false),
      }
    }

    /** 汇总行显示开关：缺失的键补 true（新加的一段默认可见）。 */
    function sanitizeDisplayItems(raw) {
      var d = plain(raw) || {}
      var out = {}
      for (var i = 0; i < DISPLAY_KEYS.length; i++) {
        var key = DISPLAY_KEYS[i]
        out[key] = bool(d[key], true)
      }
      return out
    }

    /** 汇总行顺序：去掉未知键与重复项；空则回落默认顺序。 */
    function sanitizeDisplayOrder(raw) {
      var list = Array.isArray(raw) ? raw : []
      var out = []
      for (var i = 0; i < list.length; i++) {
        var key = str(list[i], '')
        if (DISPLAY_KEYS.indexOf(key) < 0) continue
        if (out.indexOf(key) >= 0) continue
        out.push(key)
      }
      /* 补齐缺失的段（用户配置被裁剪过时不能让某一段永远消失）。 */
      for (var j = 0; j < DISPLAY_KEYS.length; j++) {
        if (out.indexOf(DISPLAY_KEYS[j]) < 0) out.push(DISPLAY_KEYS[j])
      }
      return out
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
        balanceSources: (Array.isArray(source.balanceSources) ? source.balanceSources : []).map(sanitizeBalanceSource),
        balanceRefreshSeconds: Math.round(clamped(source.balanceRefreshSeconds, d.balanceRefreshSeconds, 60, 3600)),
        balanceTimeoutMs: Math.round(clamped(source.balanceTimeoutMs, d.balanceTimeoutMs, 1000, 30000)),
        ledgerRetentionMonths: Math.round(clamped(source.ledgerRetentionMonths, d.ledgerRetentionMonths, 1, 24)),
        monthStartDay: Math.round(clamped(source.monthStartDay, d.monthStartDay, 1, 31)),
        displayItems: sanitizeDisplayItems(source.displayItems),
        displayOrder: sanitizeDisplayOrder(source.displayOrder),
        summaryDecimals: Math.round(clamped(source.summaryDecimals, d.summaryDecimals, 0, 4)),
        showUpdatedAt: bool(source.showUpdatedAt, d.showUpdatedAt),
        estimateBadgeText: str(source.estimateBadgeText, d.estimateBadgeText) || d.estimateBadgeText,
        incompleteBadgeText: str(source.incompleteBadgeText, d.incompleteBadgeText) || d.incompleteBadgeText,
      }
    }

    /* ──────────────────────── 价格引擎 ──────────────────────── */

    var DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    /** 设置页里 7 个复选框的顺序：周一到周日。 */
    var DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
    var PRICE_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output']
    /**
     * 没有数据时的占位符（`—`）。**必须与「观测到 0 消费 → ¥0.00」区分开** ——
     * 用户专门提过这一点，所以常量集中在这里，别在渲染里零散写字符串。
     */
    var MISSING = '—'

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
     * 把一步 `assistant-step` 的 usage 累加进桶里（**容错求和**，见 IMPLEMENTATION-PROMPT §6.1）。
     *
     * 关键差异（相对旧的严格折叠 deriveTurnTokenUsage）：缺 `cacheReadTokens` /
     * `cacheWriteTokens` 时**记 0**，而不是把整轮判为不可证；缺 `usage` 的步骤直接跳过。
     * `totalTokens` / `reasoningTokens` **不参与**计价。
     *
     * @returns {boolean} 是否真的累加了一个样本
     */
    function addStepUsage(sum, usage) {
      if (!usage || typeof usage !== 'object') return false
      var input = num(usage.inputTokens, NaN)
      var output = num(usage.outputTokens, NaN)
      if (!isFinite(input) || !isFinite(output)) return false
      sum.uncachedInputTokens += input
      sum.outputTokens += output
      sum.cacheReadTokens += num(usage.cacheReadTokens, 0)
      sum.cacheWriteTokens += num(usage.cacheWriteTokens, 0)
      return true
    }

    /**
     * 回退路径（宿主不可用时）：按每步 `assistant-step`.usage **容错求和**。
     *
     * 与旧的严格折叠相比，这条路径能在 GLM 等「provider 不报缓存桶」的路由上出数，
     * 也能让**中途被停止**的回合出数（中断那一步没有 usage → 记 0，其余步骤照常计）。
     *
     * @returns {{buckets: object|null, samples: number, steps: number}}
     *          `buckets === null` 表示整轮一个样本都没有 → 客户端不显示金额（与旧行为一致）。
     */
    function sumStepUsage(turn) {
      var sum = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      var samples = 0
      var steps = 0
      try {
        var list = turn && turn.steps ? turn.steps : null
        if (!list || typeof list.length !== 'number') return { buckets: null, samples: 0, steps: 0 }
        for (var i = 0; i < list.length; i++) {
          var step = list[i]
          steps += 1
          var data = step && step.data
          var value = data && typeof data.get === 'function' ? data.get('assistant-step') : null
          if (!value || typeof value !== 'object') continue
          if (addStepUsage(sum, value.usage)) samples += 1
        }
      } catch (err) {
        return { buckets: samples > 0 ? sum : null, samples: samples, steps: steps }
      }
      return { buckets: samples > 0 ? sum : null, samples: samples, steps: steps }
    }

    /**
     * 只借路由：从现有严格折叠结果里取 `tokenUsage.routes`。
     * 严格折叠现在已经不再用于取 token 数（改用容错求和），但它的 routes 仍然可靠
     * （路由来自 `message.source`，与用量完整性无关）。
     */
    function readFoldRoutes(tail) {
      var usage = tail && tail.tokenUsage
      var routes = usage && Array.isArray(usage.routes) ? usage.routes : []
      return routes.filter(function (r) {
        return r && str(r.provider, '') !== '' && str(r.model, '') !== ''
      })
    }

    /**
     * 计算一份 token 用量（4 个桶 + 路由列表）的金额。
     *
     * 这是**唯一的计价入口**：主路径（宿主折叠）与回退路径（按每步 usage 求和）
     * 都折成同样的形状后交给它，于是计费语义只有一份实现。
     *
     * @param buckets 形如 `{uncachedInputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?}`
     * @param routes  形如 `[{provider, model}, …]`；为空 = 无法确定模型
     * @returns {{ ok: boolean, reason?: string, total?, parts?, rule?, entry?, route?, routes?, ms? }}
     */
    function computeCost(buckets, routes, cfg, ms) {
      routes = Array.isArray(routes) ? routes : []
      /* routes 为空 = 无法确定模型；多路由时取最后一次尝试的路由
         （宿主折叠按出现顺序去重，末位即最近一次），并在明细里标注。 */
      var route = routes.length ? routes[routes.length - 1] : null
      var entry = route === null ? null : findEntry(cfg, route.provider, route.model)
      var usage = buckets || {}
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
      return sign + (cfg.currency || '¥') + text
    }

    /**
     * 汇总行的金额格式化：**固定小数位**，不做"小于精度就给有效数字"的补偿。
     *
     * 汇总行是给人扫一眼的概览，位数跳动会更难读；而且**绝不能**把 0 显示成
     * 「看起来像有值」的样子。实在小于精度就显示成 `¥0.00`（这与「没有数据」
     * 的 `—` 是两回事：一个是观测到 0 消费，一个是没观测）。
     */
    function formatMoneyFixed(value, cfg, decimals) {
      var digits = Math.max(0, Math.min(6, Math.round(num(decimals, 2))))
      var sign = value < 0 ? '-' : ''
      /* `|| '¥'` 而不是 `str(cfg.currency, '¥')`：`str()` 只在**非字符串**时兜底，
         空串与 `'undefined'` 这种字符串会原样拼进金额（2026-10-05 用户实测到
         「12.85undefined」）。币种永远不能变成 undefined。 */
      return sign + (cfg.currency || '¥') + Math.abs(value).toFixed(digits)
    }

    /**
     * 余额该用什么币种**显示**。
     *
     * 规则（2026-10-06）：余额币种与用户配置的显示币种**同币种**时才用符号
     * （`CNY` + 配置 `¥` → `¥`）；**不同币种一律显示 ISO 码** ——
     * 否则美元账户会被渲染成 `¥58`，那是撒谎。
     *
     * 余额段的 `currency` 只能来自适配器（账本 `observeBalance` 要求 3 位 ISO 码，
     * 符号 `¥` 会让观测整条被拒），所以显示层必须在这里做一次映射。
     */
    function balanceDisplayCurrency(balance, cfg) {
      var iso = String((balance && balance.currency) || '').toUpperCase()
      var shown = String((cfg && cfg.currency) || '')
      if (shown === '') return iso || 'CNY'
      /* 配置里写的可能就是 ISO 码本身（`CNY`），那就直接用。 */
      if (shown.toUpperCase() === iso) return shown
      /* 符号映射：¥/￥/RMB → CNY，$ → USD，€ → EUR，£ → GBP。 */
      var symbolMap = { '¥': 'CNY', '￥': 'CNY', RMB: 'CNY', $: 'USD', '€': 'EUR', '£': 'GBP' }
      var mapped = symbolMap[shown.toUpperCase()] || symbolMap[shown] || ''
      if (mapped !== '' && mapped === iso) return shown
      return iso || shown
    }

    /** 一段汇总值：有数字就是金额，没有就是 `—`。 */
    function summaryAmountText(amount, cfg, decimals) {
      if (amount === null || amount === undefined || !isFinite(amount)) return null
      return formatMoneyFixed(amount, cfg, decimals)
    }

    /**
     * 聚合汇总（本月 / 今日真实 / 日历合计）的金额文本，**多币种并排**。
     *
     * 宿主的聚合口径是「每个来源各算各的余额差值，**按币种分组**相加」：
     *   · 单一币种 → `amount` + `currency`，正常显示（`CNY` + 配置 `¥` → `¥`）；
     *   · 多币种 → `amount` 是 `null`（人民币与美元相加没有任何含义），只有
     *     `byCurrency` 有值 —— 这里并排显示成 `¥1.23 + $0.45`。
     *     **绝不能**把美元那组套上 `¥`（那是撒谎，与余额段的币种纪律同一条）。
     *
     * @returns 金额文本；一个数字都没有时返回 `null`（界面显示 `—`，与 `¥0.00` 区分）。
     */
    function aggregateAmountText(node, cfg, decimals) {
      if (node === null || node === undefined) return null
      var groups = Array.isArray(node.byCurrency) ? node.byCurrency : []
      /* 多币种（或有分组但没有合计数字，例如区间里混了币种）→ 按分组并排显示。 */
      var useGroups = groups.length > 1
        || (groups.length === 1 && (node.amount === null || node.amount === undefined))
      if (useGroups) {
        var texts = []
        for (var i = 0; i < groups.length; i++) {
          var one = summaryAmountText(groups[i].amount, { currency: balanceDisplayCurrency(groups[i], cfg) }, decimals)
          if (one !== null) texts.push(one)
        }
        return texts.length ? texts.join(' + ') : null
      }
      if (node.amount === null || node.amount === undefined) return null
      return summaryAmountText(node.amount, { currency: balanceDisplayCurrency(node, cfg) }, decimals)
    }

    /**
     * 「分来源明细」表格的行：多来源余额观测里**每一本账各自的差值**。
     *
     * 用户 2026-10-06 的要求就是「分别算各模型的余额差值、再加起来」——
     * 合计在汇总行，这张表是「分别」那一半（没有它，用户没法核对合计对不对）。
     */
    function sourceRows(sources, cfg, decimals) {
      var rows = []
      var list = Array.isArray(sources) ? sources : []
      for (var i = 0; i < list.length; i++) {
        var item = list[i] || {}
        var label = str(item.label, str(item.scope, '未知来源'))
        if (item.duplicateOf !== undefined && item.duplicateOf !== '') {
          rows.push([label, '不计入合计', '与另一条来源是同一把密钥（同一账户），已去重'])
          continue
        }
        if (item.observed !== true) {
          rows.push([
            label,
            MISSING,
            num(item.turnCount, 0) > 0 ? '有轮次但没观测到（合计偏小）' : '没有观测',
          ])
          continue
        }
        var status = []
        if (item.partialDay === true) status.push('不完整')
        if (item.needsReview === true) status.push('待核对（余额上升过）')
        if (item.corrected === true) status.push('已手工校正')
        var currency = balanceDisplayCurrency({ currency: item.currency }, cfg)
        rows.push([
          label,
          formatMoneyFixed(num(item.amount, 0), { currency: currency }, decimals),
          status.length ? status.join(' · ') : '完整',
        ])
      }
      return rows
    }

    /** 分来源表里用的「观测区间」文本（没观测就是 `—`）。 */
    function sourceWindowText(item, cfg) {
      if (item === null || item === undefined || item.observed !== true) return MISSING
      return formatClock(item.firstAt, cfg) + ' ~ ' + formatClock(item.lastAt, cfg)
    }

    /** 「更新于 x 分钟前」。justNow 时给「刚刚」。 */
    function formatRelativeTime(fromMs, nowMs) {
      var from = num(fromMs, NaN)
      var at = num(nowMs, Date.now())
      if (!isFinite(from) || from <= 0) return ''
      var seconds = Math.max(0, Math.round((at - from) / 1000))
      if (seconds < 45) return '刚刚'
      var minutes = Math.round(seconds / 60)
      if (minutes < 60) return minutes + ' 分钟前'
      var hours = Math.round(minutes / 60)
      if (hours < 24) return hours + ' 小时前'
      return Math.round(hours / 24) + ' 天前'
    }

    /**
     * 逐轮计价：把宿主/账本给的每轮桶按**各自的时刻**算钱并求和。
     *
     * ⚠️ 必须逐轮算，不能先把桶合并再算一次 —— 峰谷价随时刻变化，
     * 合并后用一个时刻计价会让跨时段的轮次算错（IMPLEMENTATION-PROMPT §10.3）。
     *
     * @param turns `[{t, p, m, i, o, cr, cw}]` 或宿主形态 `{endTime, route?, buckets?}`
     * @returns `{total, priced, unpriced, unpricedReasons}`
     */
    function priceTurns(turns, cfg) {
      var list = Array.isArray(turns) ? turns : []
      var total = 0
      var priced = 0
      var unpriced = 0
      var reasons = []
      for (var i = 0; i < list.length; i++) {
        var item = list[i] || {}
        /* 两种形态归一：账本估算轮次（p/m/i/o/cr/cw）与宿主轮次（endTime/route/buckets）。 */
        var buckets = item.buckets !== undefined ? item.buckets : {
          uncachedInputTokens: item.i,
          outputTokens: item.o,
          cacheReadTokens: item.cr,
          cacheWriteTokens: item.cw,
        }
        if (buckets === null || buckets === undefined) { unpriced += 1; continue }
        var route = item.route !== undefined ? item.route : (item.p || item.m ? { provider: item.p, model: item.m } : null)
        if (route === null) { unpriced += 1; continue }
        var ms = toMs(item.endTime !== undefined ? item.endTime : item.t)
        var result = computeCost(buckets, [route], cfg, ms)
        if (!result.ok) {
          unpriced += 1
          if (reasons.indexOf(result.reason) < 0) reasons.push(result.reason)
          continue
        }
        total += result.total
        priced += 1
      }
      return { total: total, priced: priced, unpriced: unpriced, unpricedReasons: reasons }
    }

    /**
     * 子会话计价：每个子会话**只有会话级 4 桶**（tokenUsage 投影）+ 一条路由，
     * 按它自己最后一条 assistant 消息的模型计价。
     *
     * 这是**近似**（没有逐轮时刻，所以峰谷/特价只能按"当前"判定不了）——
     * 用户拍板接受，代价是明细里必须写明「按 <provider>/<model> 计价」。
     */
    function priceChildren(children, cfg) {
      var list = Array.isArray(children) ? children : []
      var total = 0
      var priced = 0
      var unpriced = 0
      var details = []
      for (var i = 0; i < list.length; i++) {
        var child = list[i] || {}
        var buckets = child.buckets
        var route = child.route
        if (!buckets || !route) {
          unpriced += 1
          details.push({ child: child, ok: false, reason: buckets ? 'no-route' : 'no-usage' })
          continue
        }
        /* 子会话没有"回合结束时刻"，用 now 判峰谷 —— 也是近似的一部分。 */
        var result = computeCost(buckets, [route], cfg, Date.now())
        if (!result.ok) {
          unpriced += 1
          details.push({ child: child, ok: false, reason: result.reason })
          continue
        }
        total += result.total
        priced += 1
        details.push({ child: child, ok: true, amount: result.total, rule: result.rule, route: route })
      }
      return { total: total, priced: priced, unpriced: unpriced, details: details }
    }

    /**
     * 汇总行 5 段的装配（**纯函数**，便于离线断言）。
     *
     * @param cfg 配置
     * @param state 宿主 `/state.json` 的结果（可能为 null = 宿主不可用）
     * @param usage 宿主 `/usage.json` 的结果（可能为 null）
     * @returns `{segments: [{key,labelStack}], sessionTotal, todayEstimate, updatedAt, hostOnline}`
     */
    function buildSummary(cfg, state, usage) {
      var decimals = Math.max(0, Math.min(4, Math.round(num(cfg.summaryDecimals, 2))))
      var badge = str(cfg.estimateBadgeText, '估算') || '估算'
      var hostOnline = state !== null && state !== undefined && state.ok === true

      var balanceText = null
      var balanceQuota = null
      var balanceReason = ''
      if (hostOnline) {
        var balance = state.balance || {}
        /* ⚠️ 币种分工（2026-10-06 定死）：
           · `balance.currency` 是**余额币种**，适配器的 3 位 ISO 码（CNY/USD）——
             取数与入账**必须**用它（账本不接受符号 `¥`）；
           · `cfg.currency` 是用户的**显示币种**（默认 `¥`），只在**两边同币种**时
             用来把 `CNY` 换成更好看的 `¥`。
           不同币种时**绝不能**套用显示符号（美元账户显示成 `¥58` 就是撒谎）。 */
        if (balance.known === true) {
          balanceText = summaryAmountText(balance.amount, { currency: balanceDisplayCurrency(balance, cfg) }, decimals)
        } else if (balance.kind === 'quota' && Array.isArray(balance.windows) && balance.windows.length) balanceQuota = balance.windows
        else balanceReason = balance.reason || state.balanceReason || ''
      } else {
        balanceReason = state && state.reason ? state.reason : 'host-offline'
      }

      var monthText = null
      var monthIncomplete = false
      if (hostOnline && state.month) {
        /* 有观测才给金额；一天都没观测过 → `—`（不是 ¥0.00）。
           金额口径 = **全部来源的余额差值之和**（见 aggregateAmountText 的注释）。 */
        monthText = state.month.hasAnyObservation === true
          ? aggregateAmountText(state.month, cfg, decimals)
          : null
        monthIncomplete = state.month.hasGap === true
          || (Array.isArray(state.month.needsReviewDays) && state.month.needsReviewDays.length > 0)
          /* 某个来源在这个区间里「跑过轮次却没观测到」→ 合计一定偏小，必须标出来。 */
          || (Array.isArray(state.month.unobservedScopes) && state.month.unobservedScopes.length > 0)
      }

      var todayRealText = null
      var todayIncomplete = false
      if (hostOnline && state.todayReal) {
        todayRealText = aggregateAmountText(state.todayReal, cfg, decimals)
        todayIncomplete = state.todayReal.partialDay === true
          || state.todayReal.needsReview === true
          /* 今天还有来源没取到余额（但有轮次）→ 今天的合计是下限。 */
          || (Array.isArray(state.todayReal.unobservedScopes) && state.todayReal.unobservedScopes.length > 0)
      }

      /* 今日估算：账本里今天的逐轮估算（客户端按各自时刻计价）。 */
      var todayEstimate = null
      if (hostOnline && Array.isArray(state.todayTurns) && state.todayTurns.length) {
        var pricedToday = priceTurns(state.todayTurns, cfg)
        todayEstimate = pricedToday.priced > 0 ? pricedToday.total : null
      }

      /* 会话总计：**父会话逐轮精确 + 子会话按 tokenUsage 投影 × 单价**（§9）。
         子会话那半边天生是近似，所以带 `[估算]` 徽标并在明细里标注计价模型。 */
      var sessionTotal = null
      var sessionTurns = usage && Array.isArray(usage.turns) ? usage.turns : []
      var sessionPriced = priceTurns(sessionTurns, cfg)
      var childItems = usage && Array.isArray(usage.children) ? usage.children : []
      var childPriced = priceChildren(childItems, cfg)
      if (sessionPriced.priced > 0 || childPriced.priced > 0) {
        sessionTotal = sessionPriced.total + childPriced.total
      }

      var texts = {
        balance: balanceText,
        month: monthText,
        todayReal: todayRealText,
        todayEstimate: todayEstimate === null ? null : summaryAmountText(todayEstimate, cfg, decimals),
        sessionTotal: sessionTotal === null ? null : summaryAmountText(sessionTotal, cfg, decimals),
      }
      var incompleteFlags = {
        balance: false,
        month: monthIncomplete,
        todayReal: todayIncomplete,
        todayEstimate: false,
        /* 会话不完整 = 会话日志没加载全，**或**子代理列表被上限截断（§9「有 truncated 时行内加部分标记」）。 */
        sessionTotal: (usage && usage.complete === false)
          || !!(usage && usage.childrenSummary && usage.childrenSummary.truncated === true),
      }
      /* 带 `[估算]` 徽标的两段（§7.2：第二段「今日」是估算口径、第五段「会话」也是）。 */
      var estimateFlags = {
        balance: false,
        month: false,
        todayReal: false,
        todayEstimate: true,
        sessionTotal: true,
      }
      var quotaFlags = {
        balance: balanceQuota !== null,
        month: false,
        todayReal: false,
        todayEstimate: false,
        sessionTotal: false,
      }

      var order = sanitizeDisplayOrder(cfg.displayOrder)
      var shown = sanitizeDisplayItems(cfg.displayItems)
      var segments = []
      for (var i = 0; i < order.length; i++) {
        var key = order[i]
        if (shown[key] !== true) continue
        segments.push({
          key: key,
          label: DISPLAY_LABELS[key] || key,
          text: quotaFlags[key] ? null : texts[key],
          quota: quotaFlags[key] ? balanceQuota : null,
          estimate: estimateFlags[key] === true,
          incomplete: incompleteFlags[key] === true,
          badge: badge,
          incompleteBadge: str(cfg.incompleteBadgeText, '数据不完整') || '数据不完整',
        })
      }

      return {
        segments: segments,
        hostOnline: hostOnline,
        balanceReason: balanceReason,
        todayEstimate: todayEstimate,
        sessionTotal: sessionTotal,
        updatedAt: hostOnline ? num(state.now, 0) : 0,
        decimals: decimals,
      }
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
      function onFormChange() {
        refreshHost()
      }
      /**
       * 接上服务端表单。**必须能晚接**：`configForms` 是另一个客户端插件注册的服务，
       * 可能在我们的 apply 之后才就绪（那时 `ctx.get('configForms')` 返回 undefined）。
       * 早期实现只在 apply 那一刻取一次 —— 取不到就永远退回 localStorage，
       * 于是设置页里**改什么都只存在浏览器里**：余额来源写不进 profile 配置，
       * 宿主 `/state.json` 永远 `no-source`，汇总行的余额恒为 `—`
       * （2026-10-06 用户实测：测试连接能显示余额，会话下面那行却一直是横杠）。
       */
      function attachForm(next) {
        if (!next || next === form) return
        form = next
        try { offForm = form.subscribe(onFormChange) } catch (err) { offForm = null }
        onFormChange()
        cached = build()
      }
      if (form) attachForm(form)
      cached = build()

      return {
        getSnapshot: function () {
          if (cached === null) cached = build()
          return cached
        },
        /** 当前接上的表单命名空间（'' = 还没接上，正在用浏览器存储）。 */
        namespace: function () { return form && form.spec ? String(form.spec.namespace || '') : '' },
        /** 供装配层在服务晚就绪时补接（见 apply() 里的 ctx.inject）。 */
        attachForm: attachForm,
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

    /**
     * 回退路径的「最近已知路由」备忘：turn 对象 → `{provider, model}`。
     *
     * 宿主不可用、且该轮的严格折叠也拿不到路由时，用**同一会话里最近一次已知的路由**
     * 兜底（比"不显示金额"更有用，明细里会注明数据来源）。
     * 以 turn 对象（快照里每轮稳定）为键，天然按会话隔离，不会跨会话串味。
     */
    var LAST_ROUTE = new Map()
    var LAST_ROUTE_LIMIT = 64

    function rememberRoute(turn, route) {
      if (!route || str(route.provider, '') === '' || str(route.model, '') === '') return
      /* 先删再插：保证「最近用过」的条目永远在 Map 末尾，淘汰时不会误删当前回合自己。 */
      if (LAST_ROUTE.has(turn)) LAST_ROUTE.delete(turn)
      LAST_ROUTE.set(turn, { provider: route.provider, model: route.model })
      while (LAST_ROUTE.size > LAST_ROUTE_LIMIT) {
        var oldest = LAST_ROUTE.keys().next()
        if (oldest.done) break
        LAST_ROUTE.delete(oldest.value)
      }
    }

    /* ──────────────────────── 宿主数据源（主路径） ──────────────────────── */

    /**
     * 宿主 `/dsh-turn-price/usage.json` 的读取与订阅缓存。
     *
     * 为什么需要它：回退路径（按每步 `assistant-step.usage` 求和）拿不到**路由** ——
     * 当一轮的严格折叠整轮返回 `undefined` 时，连带 `routes` 也没有，客户端就不知道
     * 按哪个模型计价（GLM 那一类回合正是如此）。宿主直接折原始事件，能给出路由。
     *
     * 形状与 store 一致（`getSnapshot()` + `subscribe()`），顺手复用 `useSnapshot()`
     * 的 `useSyncExternalStore` 订阅（AGENTS 提到的 API 形态兼容期写法）。
     */
    var USAGE_URL = '/dsh-turn-price/usage.json'
    var USAGE_TIMEOUT_MS = 5000
    var USAGE_REFRESH_MS = 15000

    function createUsageFeed() {
      var entries = new Map()
      var listeners = []
      var suspendedUntil = 0
      var disposed = false

      function emit() {
        var list = listeners.slice()
        for (var i = 0; i < list.length; i++) {
          try { list[i]() } catch (err) { /* 订阅者异常不影响其它订阅者 */ }
        }
      }

      function entryOf(sessionId) {
        var entry = entries.get(sessionId)
        if (entry === undefined) {
          entry = { status: 'idle', data: null, error: '', at: 0, inflight: null }
          entries.set(sessionId, entry)
        }
        return entry
      }

      function fetchNow(sessionId, force) {
        var entry = entryOf(sessionId)
        if (disposed) return entry
        if (entry.inflight !== null) return entry
        if (Date.now() < suspendedUntil) return entry
        if (typeof fetch !== 'function') {
          entry.status = 'unavailable'
          entry.error = '当前环境没有 fetch'
          suspendedUntil = Date.now() + 60000
          return entry
        }
        if (!force && entry.status === 'ready' && Date.now() - entry.at < USAGE_REFRESH_MS) return entry

        entry.status = entry.data === null ? 'loading' : 'ready'
        var controller = typeof AbortController === 'function' ? new AbortController() : null
        var timer = null
        if (controller !== null) {
          timer = setTimeout(function () {
            try { controller.abort() } catch (err) { /* ignore */ }
          }, USAGE_TIMEOUT_MS)
        }
        var url = USAGE_URL + '?sessionId=' + encodeURIComponent(sessionId)
        var request = fetch(url, {
          credentials: 'same-origin',
          signal: controller === null ? undefined : controller.signal,
          headers: { Accept: 'application/json' },
        }).then(function (response) {
          if (!response || response.ok !== true) throw new Error('HTTP ' + (response ? response.status : '?'))
          return response.json()
        }).then(function (payload) {
          if (!payload || payload.ok !== true) throw new Error(str(payload && payload.reason, 'bad-payload'))
          entry.status = 'ready'
          entry.data = payload
          entry.error = ''
          entry.at = Date.now()
        }).catch(function (err) {
          entry.status = entry.data === null ? 'failed' : 'ready'
          entry.error = err && err.message ? err.message : String(err)
          /* 宿主没装/没重启时每次渲染都 fetch 会刷屏 —— 失败后退避一分钟再试。 */
          if (entry.error.indexOf('404') >= 0 || entry.error.indexOf('Failed to fetch') >= 0 || entry.error.indexOf('aborted') >= 0) {
            suspendedUntil = Date.now() + 60000
          }
        }).then(function () {
          if (timer !== null) clearTimeout(timer)
          entry.inflight = null
          emit()
        })
        entry.inflight = request
        return entry
      }

      return {
        /** 供组件读取某一会话的宿主数据；返回**同一个对象引用**直到内容变化。 */
        getSnapshot: function (sessionId) {
          if (typeof sessionId !== 'string' || sessionId === '') return null
          var entry = entryOf(sessionId)
          /* 注意：这里**不**直接 fetch（渲染期不能有副作用）。
             真正的首次拉取由 ensure() 在 apply 时和 turnTail 的 effect 里触发。 */
          return entry
        },
        /** 主动确保已拉取/已刷新（幂等）。 */
        ensure: function (sessionId, force) {
          if (typeof sessionId !== 'string' || sessionId === '') return
          fetchNow(sessionId, force === true)
        },
        /** 宿主数据里按 `endSeq` 查某一轮。 */
        turnOf: function (sessionId, endSeq) {
          var entry = entries.get(sessionId)
          if (!entry || !entry.data || !Array.isArray(entry.data.turns)) return null
          for (var i = 0; i < entry.data.turns.length; i++) {
            if (entry.data.turns[i].endSeq === endSeq) return entry.data.turns[i]
          }
          return null
        },
        subscribe: function (listener) {
          listeners.push(listener)
          return function () {
            var index = listeners.indexOf(listener)
            if (index >= 0) listeners.splice(index, 1)
          }
        },
        dispose: function () {
          disposed = true
          entries.clear()
          listeners.length = 0
        },
      }
    }

    /** 模块级：组件与 apply 共享同一个 feed。 */
    var USAGE_FEED = null
    /** 模块级：汇总行的宿主状态源（`/state.json`）。 */
    var STATE_FEED = null
    var STATE_URL = '/dsh-turn-price/state.json'
    var STATE_REFRESH_MS = 30000

    /**
     * 汇总行的宿主数据源（`/state.json`）。
     *
     * 与 `createUsageFeed` 同构（`getSnapshot()` + `subscribe()`），但语义不同：
     * 这个**不带 sessionId 也会有内容**（余额与日账是全机的），所以键固定为 `''`。
     */
    function createStateFeed() {
      var entry = { status: 'idle', data: null, error: '', at: 0, inflight: null }
      var listeners = []
      var disposed = false

      function emit() {
        var list = listeners.slice()
        for (var i = 0; i < list.length; i++) {
          try { list[i]() } catch (err) { /* 订阅者异常不影响其它订阅者 */ }
        }
      }

      function fetchNow(sessionId, force) {
        if (disposed || entry.inflight !== null) return
        if (typeof fetch !== 'function') {
          entry.status = 'unavailable'
          entry.error = '当前环境没有 fetch'
          return
        }
        if (!force && entry.status === 'ready' && Date.now() - entry.at < STATE_REFRESH_MS) return
        entry.status = entry.data === null ? 'loading' : 'ready'
        var controller = typeof AbortController === 'function' ? new AbortController() : null
        var timer = null
        if (controller !== null) {
          timer = setTimeout(function () {
            try { controller.abort() } catch (err) { /* ignore */ }
          }, USAGE_TIMEOUT_MS)
        }
        var url = STATE_URL + (sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : '')
        /* 带上客户端已知的 provider：宿主据此匹配余额来源（见 LAST_PROVIDER 的注释）。 */
        if (LAST_PROVIDER !== '') {
          url += (sessionId ? '&' : '?') + 'provider=' + encodeURIComponent(LAST_PROVIDER)
        }
        entry.inflight = fetch(url, {
          credentials: 'same-origin',
          signal: controller === null ? undefined : controller.signal,
          headers: { Accept: 'application/json' },
        }).then(function (response) {
          if (!response || response.ok !== true) throw new Error('HTTP ' + (response ? response.status : '?'))
          return response.json()
        }).then(function (payload) {
          if (!payload || payload.ok !== true) throw new Error(str(payload && payload.reason, 'bad-payload'))
          entry.status = 'ready'
          entry.data = payload
          entry.error = ''
          entry.at = Date.now()
        }).catch(function (err) {
          entry.status = entry.data === null ? 'failed' : 'ready'
          entry.error = err && err.message ? err.message : String(err)
        }).then(function () {
          if (timer !== null) clearTimeout(timer)
          entry.inflight = null
          emit()
        })
      }

      return {
        getSnapshot: function () { return entry },
        ensure: function (sessionId, force) { fetchNow(sessionId, force === true) },
        /** 强制刷新余额（点击「更新于 x 分钟前」时调用）。 */
        refresh: function (sessionId) {
          if (typeof fetch !== 'function') return
          var url = '/dsh-turn-price/refresh' + (sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : '')
          fetch(url, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' } })
            .then(function () { entry.at = 0; fetchNow(sessionId, true) })
            .catch(function () { entry.at = 0; fetchNow(sessionId, true) })
        },
        subscribe: function (listener) {
          listeners.push(listener)
          return function () {
            var index = listeners.indexOf(listener)
            if (index >= 0) listeners.splice(index, 1)
          }
        },
        dispose: function () {
          disposed = true
          listeners.length = 0
        },
      }
    }

    /**
     * 取当前会话的宿主数据（如果宿主在线且该轮已折出）。
     * @returns {object|null} 宿主那一轮的数据
     */
    function hostTurnOf(sessionId, endSeq) {
      if (USAGE_FEED === null) return null
      if (typeof sessionId !== 'string' || sessionId === '') return null
      if (typeof endSeq !== 'number') return null
      return USAGE_FEED.turnOf(sessionId, endSeq)
    }

    /**
     * 一轮的计价输入：token 桶 + 路由 + 数据来源。
     *
     * **主路径**：宿主 `/usage.json` 折出的该轮数据（含路由）；
     * **回退路径**：宿主不可用时按每步 `assistant-step.usage` 容错求和、路由只借严格折叠。
     * 两条路径返回同样的形状，交给同一个 `computeCost` —— 计费语义只有一份实现。
     *
     * `buckets === null` → 该轮一个用量样本都没有 → **不显示金额**（与旧行为一致）。
     */
    function resolveTurnInput(turn, tail, sessionId) {
      /* ⚠️ 不能用 `num(tail.seq, NaN)` 取 endSeq：本文件的 `num()` 在 fallback 为
         undefined 时回落 0，而显式传 NaN 也会被原样返回 —— 两种都不是我们要的
         「拿不到就是拿不到」。这里直接判类型。 */
      var seq = tail && typeof tail.seq === 'number' && isFinite(tail.seq) ? tail.seq : null
      var host = seq === null ? null : hostTurnOf(sessionId, seq)
      if (host !== null && host !== undefined) {
        if (host.buckets === null || host.buckets === undefined) {
          /* 宿主明确说这一轮没有样本 —— 这是权威结论，不要再用回退路径"救"回来。 */
          return { buckets: null, routes: [], source: 'host', samples: 0, turn: host }
        }
        return {
          buckets: host.buckets,
          routes: Array.isArray(host.routes) ? host.routes : [],
          source: 'host',
          samples: num(host.samples, 0),
          turn: host,
        }
      }

      var sum = sumStepUsage(turn)
      var routes = readFoldRoutes(tail)
      if (routes.length) rememberRoute(turn, routes[routes.length - 1])
      else {
        var known = LAST_ROUTE.get(turn)
        if (known) routes = [known]
      }
      return { buckets: sum.buckets, routes: routes, source: 'client', samples: sum.samples, turn: null }
    }

    /**
     * 从 turn 快照里取会话 id。
     *
     * `conversation.chat.turnTail` 的 standardProps 里没有 `sessionId`（它给的是
     * `turn` / `seq` / `openFile`），而 turn 快照本身就是按会话实例化的，其 `id`
     * 就是会话 id。`props.sessionId` 作为兼容兜底（若将来该插槽补上这个 prop）。
     */
    function sessionIdOf(props) {
      if (props && typeof props.sessionId === 'string' && props.sessionId !== '') return props.sessionId
      var turn = props && props.turn
      if (turn && typeof turn.id === 'string' && turn.id !== '') return turn.id
      return ''
    }

    function CostTail(props) {
      var openPair = React.useState(false)
      var open = openPair[0]
      var setOpen = openPair[1]
      var store = STORE
      var snap = useSnapshot(store)
      var cfg = snap.value || defaultConfig()
      var tail = readTurnTail(props.turn)
      var sessionId = sessionIdOf(props)

      /* 订阅宿主数据源：它到货后本组件必须重绘（hook 必须**无条件**调用）。 */
      var feedPair = React.useState(0)
      var bumpFeed = feedPair[1]
      React.useEffect(function () {
        if (USAGE_FEED === null || sessionId === '') return undefined
        USAGE_FEED.ensure(sessionId, false)
        return USAGE_FEED.subscribe(function () { bumpFeed(function (n) { return n + 1 }) })
      }, [sessionId])

      if (!cfg.enabled || tail === null) return null

      var input = resolveTurnInput(props.turn, tail, sessionId)
      if (input.buckets === null) return null
      var ms = toMs(tail.time)
      var result = computeCost(input.buckets, input.routes, cfg, ms)
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
          /* 措辞按**实测**的官方语义：路由列表是「首次出现顺序」，「最后一个」= 最后一个
             不同的路由，不一定是"最后一次尝试"。详见 README 的说明，不要写成"末次尝试"。 */
          + (result.routes.length > 1 ? '（本轮经过 ' + result.routes.length + ' 个路由，按路由表中的最后一个计价）' : '')))
      if (clock !== null) meta.push(h('div', { key: 'time' }, '计费时刻：' + clock.ymd + ' ' + clock.hm + '（UTC' + (cfg.tzOffset >= 0 ? '+' : '') + cfg.tzOffset + '，' + clock.dayName + '）'))
      meta.push(h('div', { key: 'src' }, input.source === 'host'
        ? 'token 来源：宿主折叠的会话事件，按每步 usage 容错求和（' + input.samples + ' 个样本）'
          + (input.turn && input.turn.reason ? '；回合结束原因：' + input.turn.reason : '')
          + (input.turn && input.turn.interrupted ? '；该回合曾被中断' : '')
        : 'token 来源：本页会话数据，按每步 usage 容错求和（' + input.samples + ' 个样本；宿主未连接）'))
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

    /* ──────────────────────── 汇总行（composer dock）──────────────────────── */

    /**
     * 当前会话最后使用的 provider。
     *
     * 为什么要由客户端回传：宿主侧的会话折叠缓存只覆盖**插件启动之后**的事件，
     * 而用户当前这个会话往往在插件启动前就存在 → 宿主算不出 provider → 匹配不到余额来源
     * → 汇总行的「余额」永远是 —（2026-07-05 实测的真因之一）。
     * 客户端手上本来就有每轮的路由（`/usage.json` 的 `turns[].route`），顺手带上即可。
     */
    var LAST_PROVIDER = ''

    /** 从 `/usage.json` 的响应里取最后一个有路由的 provider（与宿主同一套「最后一个」语义）。 */
    function providerOfUsage(usage) {
      if (!usage || !Array.isArray(usage.turns)) return ''
      for (var i = usage.turns.length - 1; i >= 0; i--) {
        var route = usage.turns[i] && usage.turns[i].route
        if (route && route.provider) return String(route.provider)
      }
      return ''
    }

    /**
     * 订阅一个 feed 并在它变化时重绘（返回版本号，调用方不需要读它）。
     *
     * 与 `useSnapshot` 分开：feed 的 `getSnapshot()` 需要参数（sessionId），
     * 形状与 `useSyncExternalStore` 的三参数形式不兼容，所以用「订阅 + 计数」。
     */
    function useFeedVersion(feed, sessionId) {
      var pair = React.useState(0)
      var bump = pair[1]
      React.useEffect(function () {
        if (feed === null) return undefined
        feed.ensure(sessionId, false)
        return feed.subscribe(function () { bump(function (n) { return n + 1 }) })
      }, [feed, sessionId])
      return pair[0]
    }

    /** 汇总行明细面板里的一行小表格。 */
    function MiniTable(props) {
      var rows = props.rows || []
      if (rows.length === 0) return null
      return h('table', { className: 'dtc-table' },
        props.head ? h('thead', null, h('tr', null, props.head.map(function (label, index) {
          return h('th', { key: index, className: index === 0 ? null : 'dtc-num' }, label)
        }))) : null,
        h('tbody', null, rows.map(function (cells, index) {
          return h('tr', { key: index }, cells.map(function (cell, cellIndex) {
            return h('td', { key: cellIndex, className: cellIndex === 0 ? null : 'dtc-num' }, cell)
          }))
        })),
      )
    }

    /** 某个汇总段的明细内容（纯展示，数据都来自宿主 state/usage）。 */
    function SummaryDetail(props) {
      var cfg = props.cfg
      var state = props.state
      var usage = props.usage
      var summary = props.summary
      var decimals = summary.decimals

      if (props.segment === 'balance') {
        var balance = (state && state.balance) || {}
        if (balance.known === true) {
          return h('div', null,
            h('div', { className: 'dtc-meta' },
              h('div', null, '来源：' + (balance.sourceLabel || balance.provider || '未知')),
              /* 明细里把两个币种都写清楚：ISO 码是入账口径，符号是显示口径。 */
              h('div', null, '币种：' + str(balance.currency, cfg.currency) + (cfg.currency && cfg.currency !== balance.currency ? '（显示为 ' + cfg.currency + '）' : '')),
              h('div', null, '取数时刻：' + formatClock(balance.at, cfg)),
              h('div', null, '余额：' + formatMoneyFixed(balance.amount, { currency: balanceDisplayCurrency(balance, cfg) }, decimals)),
            ),
            balance.raw ? h('div', { className: 'dtc-hint' }, '原始返回摘要：' + String(balance.raw).slice(0, 300)) : null,
            /* 「额度接口不可用 → 已改查现金余额」这类说明要照实显示，
               否则用户会以为自己看的是 Coding Plan 额度。 */
            balance.note ? h('div', { className: 'dtc-note' }, String(balance.note)) : null,
          )
        }
        if (balance.kind === 'quota' && Array.isArray(balance.windows) && balance.windows.length) {
          return h('div', null,
            h('div', { className: 'dtc-meta' }, '这是**额度**（订阅/资源包），不是余额金额。'),
            h(MiniTable, {
              head: ['窗口', '剩余', '重置时间'],
              rows: balance.windows.map(function (win) {
                return [
                  str(win.label, win.key),
                  win.percent === undefined ? MISSING : (Math.round(win.percent * 10) / 10) + '%',
                  win.resetAt ? formatClock(win.resetAt, cfg) : MISSING,
                ]
              }),
            }),
          )
        }
        return h('div', null,
          h('div', { className: 'dtc-meta' },
            h('div', null, '宿主不可用或没有可用来源。'),
            h('div', null, '原因：' + str(balance.reasonText || balance.reason || summary.balanceReason || '未知')),
            h('div', null, '去「设置 → 每轮花费 → 账户与余额」里添加来源并测试连接。'),
          ),
        )
      }

      if (props.segment === 'month') {
        var month = (state && state.month) || null
        if (month === null) return h('div', { className: 'dtc-meta' }, '宿主不可用，暂时拿不到本月数据。')
        /* ⚠️ `state.month` 只带汇总数字，逐天明细在 `state.history.days`（同一区间、同一聚合口径）。
           旧实现读 `month.days`（宿主从来没给过这个字段）→ 面板里的逐天表格**永远是空的**。 */
        var monthDays = Array.isArray(month.days) ? month.days
          : (state && state.history && Array.isArray(state.history.days) ? state.history.days : [])
        return h('div', null,
          h('div', { className: 'dtc-meta' },
            h('div', null, '统计区间：' + month.from + ' ~ ' + month.to + '（每月起始日 ' + month.monthStartDay + '）'),
            h('div', null, '合计 = 各来源余额差值之和（按币种分别相加）'),
            h('div', null, '有观测的天数：' + month.observedDays),
            month.needsReviewDays && month.needsReviewDays.length ? h('div', null, '待核对（当天余额上升过）：' + month.needsReviewDays.join('、')) : null,
          ),
          h(MiniTable, {
            head: ['来源', '本月真实消费', '有观测天数'],
            rows: (Array.isArray(month.sources) ? month.sources : []).map(function (item) {
              return [
                str(item.label, item.scope),
                formatMoneyFixed(num(item.amount, 0), { currency: balanceDisplayCurrency({ currency: item.currency }, cfg) }, decimals),
                num(item.observedDays, 0),
              ]
            }),
          }),
          h(MiniTable, {
            head: ['日期', '真实消费', '状态'],
            rows: monthDays.filter(function (row) { return row.missing !== true || row.amountUnits !== null || row.mixedCurrency === true })
              .slice(-31)
              .map(function (row) {
                if (row.missing === true) return [row.day, MISSING, row.future ? '尚未到来' : '无观测']
                var status = []
                if (row.partialDay === true) status.push('不完整')
                if (row.inProgress === true) status.push('观测中')
                if (row.needsReview === true) status.push('待核对')
                if (row.mixedCurrency === true) status.push('混合币种')
                if (Array.isArray(row.unobservedScopes) && row.unobservedScopes.length) status.push('有来源未观测')
                return [
                  row.day,
                  aggregateAmountText(row, cfg, decimals) === null ? MISSING : aggregateAmountText(row, cfg, decimals),
                  status.length ? status.join(' · ') : '完整',
                ]
              }),
          }),
          month.hasGap ? h('div', { className: 'dtc-hint' }, '区间内存在「无观测」或「观测不完整」的日子，合计偏小。') : null,
        )
      }

      if (props.segment === 'todayReal') {
        var today = state && state.todayReal
        if (!today) {
          return h('div', { className: 'dtc-meta' },
            h('div', null, '今天还没有余额观测。'),
            h('div', null, '观测只在「界面开着 + 能取到余额」时发生；今天不算「不完整」，只是还没开始。'))
        }
        var todaySources = Array.isArray(today.sources) ? today.sources : []
        var todayObserved = todaySources.filter(function (item) { return item && item.observed === true })
        /* 单一币种时给合计的期初/期末/增减；多币种时那些数字没有意义（宿主给 null）。 */
        return h('div', null,
          h('div', { className: 'dtc-meta' },
            h('div', null, '今日真实消费 = **各来源余额差值之和**（'
              + todayObserved.length + ' 个来源有观测'
              + (todaySources.length > todayObserved.length ? '，另有 ' + (todaySources.length - todayObserved.length) + ' 个没有' : '')
              + '）'),
            h('div', null, '观测起点：' + formatClock(today.observedFromMs, cfg)),
            h('div', null, '最近观测：' + formatClock(today.observedToMs, cfg)),
            today.currency
              ? h('div', null, '合计期初余额：' + formatMoneyFixed(today.openingBalance, { currency: balanceDisplayCurrency(today, cfg) }, decimals))
              : null,
            today.currency
              ? h('div', null, '合计当前余额：' + formatMoneyFixed(today.currentBalance, { currency: balanceDisplayCurrency(today, cfg) }, decimals))
              : null,
            today.currency
              ? h('div', null, '观测到的下降：' + formatMoneyFixed(today.observedDecrease, { currency: balanceDisplayCurrency(today, cfg) }, decimals))
              : null,
            today.currency && today.observedIncrease > 0
              ? h('div', null, '观测到的上升（可能含充值）：' + formatMoneyFixed(today.observedIncrease, { currency: balanceDisplayCurrency(today, cfg) }, decimals))
              : null,
            h('div', null, today.inProgress === true ? '今天仍在观测中。' : (today.partialDay === true ? '今天的数据不完整。' : '今天的数据完整。')),
            today.corrected ? h('div', null, '已有来源做过手工校正（在下面的分来源表里标出）。') : null,
          ),
          h(MiniTable, {
            head: ['来源', '今日差值', '状态'],
            rows: sourceRows(todaySources, cfg, decimals),
          }),
          h(MiniTable, {
            head: ['来源', '观测区间', '期初 → 当前'],
            rows: todaySources.filter(function (item) { return item && item.observed === true }).map(function (item) {
              var currency = balanceDisplayCurrency({ currency: item.currency }, cfg)
              return [
                str(item.label, item.scope),
                sourceWindowText(item, cfg),
                formatMoneyFixed(num(item.openingUnits, 0) / 100000000, { currency: currency }, decimals)
                  + ' → ' + formatMoneyFixed(num(item.lastUnits, 0) / 100000000, { currency: currency }, decimals),
              ]
            }),
          }),
          today.mixedCurrency === true
            ? h('div', { className: 'dtc-note' },
                '今天观测到的来源**币种不同**（' + today.byCurrency.map(function (g) { return str(g.currency, '?') }).join(' / ')
                + '）：合计按币种分别给出，**不跨币种相加**（人民币与美元相加没有意义）。')
            : null,
          Array.isArray(today.unobservedScopes) && today.unobservedScopes.length
            ? h('div', { className: 'dtc-note' },
                '有来源今天跑过轮次、但还没取到余额观测（合计因此偏小）：'
                + today.unobservedScopes.map(function (scope) {
                  var found = todaySources.filter(function (item) { return item.scope === scope })[0]
                  return str(found && found.label, scope)
                }).join('、'))
            : null,
          Array.isArray(today.duplicates) && today.duplicates.length
            ? h('div', { className: 'dtc-note' },
                '去重：' + today.duplicates.map(function (item) { return str(item.label, item.scope) }).join('、')
                + ' 与另一条来源是**同一把密钥**（同一个账户），只计一次以免翻倍。')
            : null,
        )
      }

      if (props.segment === 'todayEstimate') {
        var priced = priceTurns((state && state.todayTurns) || [], cfg)
        var real = state && state.todayReal ? state.todayReal.amount : null
        var diff = real === null || real === undefined ? null : (priced.total - real)
        return h('div', null,
          h('div', { className: 'dtc-meta' },
            h('div', null, '本轮按每轮 token × 当前价格表估算，共 ' + priced.priced + ' 轮'
              + (priced.unpriced ? '，另有 ' + priced.unpriced + ' 轮无法计价（' + priced.unpricedReasons.join('/') + '）' : '')),
            h('div', null, '只统计**本插件运行期间**发生的轮次，不回溯历史（用户选定的实时增量方案）。'),
            real === null || real === undefined
              ? h('div', null, '今天还没有真实观测，无法对比。')
              : h('div', null, '与真实观测相差：' + formatMoneyFixed(diff, cfg, decimals)),
          ),
          h(MiniTable, {
            head: ['时刻', '模型', '输入', '输出', '缓存读', '缓存写'],
            rows: ((state && state.todayTurns) || []).slice(-50).map(function (turn) {
              return [
                formatClock(turn.t, cfg),
                (turn.p ? turn.p + ' / ' : '') + str(turn.m, '未知'),
                formatTokens(turn.i), formatTokens(turn.o), formatTokens(turn.cr), formatTokens(turn.cw),
              ]
            }),
          }),
        )
      }

      /* sessionTotal */
      var turns = (usage && usage.turns) || []
      var pricedSession = priceTurns(turns, cfg)
      var childItems2 = (usage && usage.children) || []
      var pricedChildren = priceChildren(childItems2, cfg)
      var childRows = pricedChildren.details.map(function (detail) {
        var child = detail.child || {}
        var label = child.label || child.title || String(child.sessionId || '').slice(0, 8)
        var routeText = detail.ok
          ? (detail.route.provider ? detail.route.provider + ' / ' : '') + detail.route.model
          : (detail.reason === 'no-usage' ? '无用量' : detail.reason === 'no-route' ? '不知道模型' : String(detail.reason))
        return [
          label,
          detail.ok ? formatMoneyFixed(detail.amount, cfg, decimals) : MISSING,
          '按 ' + routeText + ' 计价',
        ]
      })
      return h('div', null,
        h('div', { className: 'dtc-meta' },
          h('div', null, '当前会话共 ' + turns.length + ' 轮，其中 ' + pricedSession.priced + ' 轮可计价'
            + (pricedSession.unpriced ? '，' + pricedSession.unpriced + ' 轮无法计价（' + pricedSession.unpricedReasons.join('/') + '）' : '')),
          h('div', null, '数据来源：' + (usage && usage.complete === false ? '会话日志未完整加载（部分）' : '宿主折叠的完整会话日志')),
          childItems2.length
            ? h('div', null, '子代理 ' + childItems2.length + ' 个（' + pricedChildren.priced + ' 个可计价）'
              + (usage.childrenSummary && usage.childrenSummary.truncated ? '，**部分**（超出深度/数量上限）' : ''))
            : null,
          childItems2.length
            ? h('div', null, '子会话按 tokenUsage 投影 × 单价估算（没有逐轮时刻，峰谷按当前时刻判定），所以是近似值。')
            : null,
          usage && usage.childrenReason
            ? h('div', null, '拿不到子代理列表：' + String(usage.childrenReason))
            : null,
          usage && usage.childrenSummary && usage.childrenSummary.errors && usage.childrenSummary.errors.length
            ? h('div', null, '个别子代理读取失败 ' + usage.childrenSummary.errors.length + ' 个（不影响上面的数字）')
            : null,
          usage && usage.reconcile && usage.reconcile.ok === false
            ? h('div', null, '⚠️ 折叠自查未通过：' + str(usage.reconcile.reason, '未知'))
            : null,
        ),
        h(MiniTable, {
          head: ['轮', '时刻', '模型', '金额'],
          rows: turns.slice(-80).map(function (turn) {
            var route = turn.route
            var cost = turn.buckets === null ? null
              : computeCost(turn.buckets, route ? [route] : [], cfg, toMs(turn.endTime))
            return [
              String(turn.turn),
              formatClock(turn.endTime, cfg),
              route ? (route.provider ? route.provider + ' / ' : '') + route.model : '未知',
              turn.buckets === null ? MISSING : (cost && cost.ok ? formatMoneyFixed(cost.total, cfg, decimals) : MISSING),
            ]
          }),
        }),
        childRows.length
          ? h('div', null,
            h('div', { className: 'dtc-sum-panel-title' }, h('span', null, '子代理')),
            h(MiniTable, { head: ['子代理', '金额', '计价模型'], rows: childRows }))
          : null,
      )
    }

    /** 时刻格式化（明细面板用，16:05 这种）。 */
    function formatClock(ms, cfg) {
      var value = num(ms, NaN)
      if (!isFinite(value) || value <= 0) return MISSING
      var clock = wallClock(value, cfg.tzOffset)
      return clock.ymd + ' ' + clock.hm
    }

    /**
     * 汇总行：`余额 ¥42.17 · 本月 ¥58.30 · 今日 ¥3.42 · 今日 ¥3.10 [估算] · 会话 ¥12.85 [估算]`
     *
     * 位置由 `conversation.composer.dock` 的 **`order: 10`** 决定。
     *
     * ⚠️ **order 是升序**（`dsh-client-ui-slots`：
     * `next.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))`）。
     * 内置 `stats`（性能与用量）是 `order: 0`，所以：
     *   · `order < 0` → 我们的行在 stats **上面**（早期实现，理解反了）
     *   · `order > 0` → 我们的行在 stats **下面**（用户 2026-10-05 更正后的要求）
     */
    function SummaryRow(props) {
      var sessionId = str(props && props.sessionId, '')
      var store = STORE
      var snap = useSnapshot(store)
      var cfg = snap.value || defaultConfig()
      useFeedVersion(STATE_FEED, sessionId)
      useFeedVersion(USAGE_FEED, sessionId)
      var openPair = React.useState('')
      var open = openPair[0]
      var setOpen = openPair[1]

      if (!cfg.enabled) return null

      var stateEntry = STATE_FEED ? STATE_FEED.getSnapshot() : null
      var state = stateEntry && stateEntry.data ? stateEntry.data : null
      var usageEntry = USAGE_FEED ? USAGE_FEED.getSnapshot(sessionId) : null
      var usage = usageEntry && usageEntry.data ? usageEntry.data : null

      /* 记下本会话最后的路由，供 `/state.json` 匹配余额来源用。
         ⚠️ 必须放 effect 里：render 期间调 `ensure()` 会 setState → 可能反复渲染。 */
      var usageProvider = providerOfUsage(usage)
      React.useEffect(function () {
        if (usageProvider === '' || usageProvider === LAST_PROVIDER) return
        LAST_PROVIDER = usageProvider
        /* 之前那次 state 请求没带 provider，余额可能因此是 —；拿到路由后补一次。 */
        if (STATE_FEED !== null) STATE_FEED.ensure(sessionId, true)
      }, [usageProvider, sessionId])

      var summary = buildSummary(cfg, state, usage)
      if (summary.segments.length === 0) return null

      var children = []
      for (var j = 0; j < summary.segments.length; j++) {
        ;(function (segment, index) {
          if (index > 0) children.push(h('span', { key: 'sep' + index, className: 'dtc-sum-sep' }, '·'))
          var valueNode
          if (segment.quota !== null && segment.quota !== undefined) {
            var best = segment.quota[0]
            valueNode = h('span', { className: 'dtc-sum-amount' }, best.percent === undefined ? MISSING : Math.round(best.percent * 10) / 10 + '%')
          } else if (segment.text === null) {
            valueNode = h('span', { className: 'dtc-sum-missing' }, MISSING)
          } else {
            valueNode = h('span', { className: 'dtc-sum-amount' }, segment.text)
          }
          var badges = []
          if (segment.estimate) badges.push(h('span', { key: 'est', className: 'dtc-badge' }, segment.badge))
          if (segment.incomplete) badges.push(h('span', { key: 'inc', className: 'dtc-badge dtc-badge-peak' }, segment.incompleteBadge))
          children.push(h('button', {
            key: segment.key,
            type: 'button',
            className: 'dtc-sum-seg',
            'aria-expanded': open === segment.key,
            title: segment.label + '（点击查看明细）',
            onClick: function () { setOpen(open === segment.key ? '' : segment.key) },
          },
            h('span', { className: 'dtc-sum-label' }, segment.label),
            valueNode,
            badges.length ? badges : null,
          ))
        })(summary.segments[j], j)
      }

      /* 「更新于 x 分钟前」：只在宿主在线且有取数时刻时显示；点击强制刷新。 */
      if (cfg.showUpdatedAt && summary.hostOnline) {
        var relative = formatRelativeTime(summary.updatedAt, Date.now())
        if (relative !== '') {
          children.push(h('button', {
            key: 'updated',
            type: 'button',
            className: 'dtc-sum-updated',
            title: '点击立即刷新余额',
            onClick: function () { if (STATE_FEED) STATE_FEED.refresh(sessionId) },
          }, '更新于 ' + relative))
        }
      }

      /* 展开的明细面板：整行下一行（flex-basis:100%） */
      if (open !== '') {
        var target = null
        for (var k = 0; k < summary.segments.length; k++) {
          if (summary.segments[k].key === open) target = summary.segments[k]
        }
        if (target !== null) {
          children.push(h('div', { key: 'panel', className: 'dtc-sum-panel' },
            h('div', { className: 'dtc-sum-panel-title' },
              h('span', null, target.label + '明细'),
              h('span', null, target.text === null ? MISSING : (target.quota ? '额度' : target.text))),
            /* 正文放独立滚动容器：面板本身固定高度，只有这里滚。 */
            h('div', { className: 'dtc-sum-panel-body' },
              h(SummaryDetail, { segment: target.key, cfg: cfg, state: state, usage: usage, summary: summary }),
              h('div', { className: 'dtc-hint' },
                '金额按当前价格表实时计算；宿主不可用时这里显示 —，轮尾金额仍会正常显示。')),
          ))
        }
      }

      return h('div', { className: 'dtc-sum', 'data-turn-cost-summary': '' }, children)
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

    /* ──────────────────── 设置页（4 个横栏选项卡）────────────────────
       2026-10-05 用户反馈改版，四点诉求：
         ① 余额来源改完保存后汇总行仍是 —（**真 bug**：余额卡片从不提交配置）；
         ② 唯一的保存按钮藏在「模型价格」下面却保存整页 → 误导；
         ③ 四张卡片纵向堆叠、没有页内导航，页面很长 → 改成**顶部横栏切换**；
         ④ 保存按钮统一放**右上角**（每个选项卡标题行的右侧）。
       这里把原来的 PriceSection 提升成 SettingsPage：4 个选项卡共用同一份 draft
       与同一个保存动作（保存的是**整份配置**，与选项卡无关 —— 文案已如实改成
       「保存全部设置」）。 */

    var SETTINGS_TABS = [
      { key: 'price', label: '模型价格' },
      { key: 'balance', label: '账户与余额' },
      { key: 'records', label: '消费记录' },
      { key: 'display', label: '显示项' },
    ]

    function SettingsPage(props) {
      var store = STORE
      var snap = useSnapshot(store)
      var cfg = snap.value || defaultConfig()
      var draftPair = React.useState(null)
      var draft = draftPair[0]
      var setDraft = draftPair[1]
      /* `tab` = 顶部横栏选中的选项卡；`modelTab` = 「模型价格」卡片内部按模型分的页签。 */
      var tabPair = React.useState('price')
      var tab = tabPair[0]
      var setTab = tabPair[1]
      var modelTabPair = React.useState(0)
      var modelTab = modelTabPair[0]
      var setModelTab = modelTabPair[1]
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
      var active = Math.min(modelTab, Math.max(0, models.length - 1))
      var activeModel = models.length ? models[active] : null

      /* 待保存的 API key：由「账户与余额」卡片填入，**右上角那一个保存按钮**统一提交。
         这样「加来源 + 填密钥」是一次保存动作，不会出现「密钥存了、来源没存」的错位
         （2026-10-05 用户报的正是这个：余额来源从来没被写进配置）。 */
      var pendingKeyPair = React.useState('')
      var pendingApiKey = pendingKeyPair[0]
      var setPendingApiKey = pendingKeyPair[1]

      function save() {
        setStatus({ text: '保存中…', kind: '' })
        /* 密钥先写：它不进配置，走宿主凭据库（只写不读回）。
           配置里只留下凭据名（credentialRef）。 */
        var credentialRef = ''
        for (var i = 0; i < current.balanceSources.length; i++) {
          if (current.balanceSources[i].credentialRef) credentialRef = current.balanceSources[i].credentialRef
        }
        var movedRef = ''
        var writeKey = pendingApiKey !== '' && credentialRef !== ''
          ? new Promise(function (resolve) {
              hostCall('/dsh-turn-price/credentials', {
                body: { action: 'set', ref: credentialRef, value: pendingApiKey },
              }, function (payload) {
                if (payload.ok) {
                  setPendingApiKey('')
                  /* 宿主为了保护模型密钥可能把这次写入**改道**到余额专用凭据名
                     （见 lib/index.js 的 providerKeyRefs 注释）。必须把来源的
                     credentialRef 一起改成新名字，否则余额会用旧名字读到错的密钥。 */
                  if (payload.moved === true && typeof payload.ref === 'string' && payload.ref !== '') {
                    movedRef = payload.ref
                    var sources = current.balanceSources.slice()
                    for (var j = 0; j < sources.length; j++) {
                      if (sources[j].credentialRef === credentialRef) sources[j] = Object.assign({}, sources[j], { credentialRef: movedRef })
                    }
                    current = Object.assign({}, current, { balanceSources: sources })
                  }
                } else setStatus({ text: '密钥保存失败：' + str(payload.detail, payload.reason) + '（设置本身仍会保存）', kind: 'dtc-err' })
                resolve()
              })
            })
          : Promise.resolve()

        return writeKey.then(function () {
          return store.save(current)
        }).then(function (ok) {
          if (!ok) {
            setStatus({ text: '保存失败：' + (store.getSnapshot().message || '未知原因'), kind: 'dtc-err' })
            return
          }
          setDraft(null)
          var wroteKey = pendingApiKey === ''
          var head = wroteKey
            ? '已保存全部设置。历史回合的金额已按新价格重算。'
            : '已保存全部设置（含密钥）。'
          if (movedRef !== '') {
            head = '已保存全部设置。为保护模型密钥，余额密钥另存为「' + movedRef + '」。'
          }
          setStatus({ text: head, kind: 'dtc-ok' })
          /* ★ 保存之后必须**核实余额来源真的落到宿主**，不能只看「保存成功」。
             2026-10-06 的 bug 就是「设置页显示成功、宿主 /state.json 却 no-source」
             —— 设置存进了浏览器，余额恒为 —。这里读回宿主状态，对不上就直说。 */
          verifyHostConfig(head)
        })
      }

      /** 保存后回读宿主状态：来源条数与启用条数必须与刚保存的一致。 */
      function verifyHostConfig(head) {
        var wanted = current.balanceSources.filter(function (s) { return s.enabled })
        if (wanted.length === 0) return
        hostCall('/dsh-turn-price/state.json', { method: 'GET' }, function (payload) {
          if (!payload || payload.ok !== true) {
            setStatus({ text: head + ' 但读不到宿主状态（宿主可能没起来）：余额可能仍显示 —', kind: 'dtc-warn' })
            return
          }
          var got = payload.balanceSources || null
          var live = got === null ? -1 : Number(got.enabled || 0)
          if (live === wanted.length) {
            setStatus({ text: head + ' 余额来源已写入宿主，正在刷新余额…', kind: 'dtc-ok' })
            /* 立刻催一次取数，别等 300 秒的定时刷新。
               取数之后**再回读一次**：`balance.known` 与 `lastObservation` 必须一起看 ——
               「取到余额」和「观测写进账本」是两件事（2026-10-06 的第四层 bug：
               前者成功、后者静默失败，于是今日真实花费永远是 ¥0.00）。 */
            hostCall('/dsh-turn-price/refresh', { body: {} }, function (after) {
              if (STATE_FEED !== null) STATE_FEED.refresh('')
              verifyObservation(head, after)
            })
            return
          }
          setStatus({
            text: head + ' ⚠ 宿主侧余额来源仍是 ' + (live < 0 ? '未知' : live + ' 个启用的')
              + '（刚保存的是 ' + wanted.length + ' 个）—— 说明这次保存没写进宿主配置，余额会一直显示 —。'
              + '请把设置页顶部的存储状态截图给插件作者。',
            kind: 'dtc-err',
          })
        })
      }

      /**
       * 刷新后核实两件事：余额取到了没有、观测入账成功没有。
       *
       * 这是「今日/本月真实花费」这条链路唯一的可见出口 —— 只报「余额取到了」
       * 会让「账本一条观测都没有」的故障继续隐形。
       */
      function verifyObservation(head, payload) {
        var state = payload && payload.ok === true ? payload : null
        if (state === null) return
        var balance = state.balance || {}
        var obs = state.lastObservation || null
        if (balance.known !== true && balance.kind !== 'quota') {
          setStatus({ text: head + ' 余额还没取到：' + str(balance.reasonText, balance.reason || state.balanceReason || '未知原因'), kind: 'dtc-warn' })
          return
        }
        if (obs === null) {
          setStatus({ text: head + ' 余额已取到，但宿主还没回报入账结果（稍后再看一次）。', kind: 'dtc-warn' })
          return
        }
        if (obs.ok === true) {
          var text = head + ' 余额 ' + formatMoneyFixed(balance.amount, { currency: current.currency || '¥' }, 2)
            + '，已记入账本（' + str(obs.day, '今天') + '）。'
          setStatus({ text: text, kind: 'dtc-ok' })
          return
        }
        /* 取到余额却没能入账 —— 今日/本月真实花费会一直是 —，必须说出来。 */
        var why = obs.reason === 'duplicate' ? '这次样本比账本里已有的更早，被当重复样本忽略'
          : obs.reason === 'threw' ? ('账本拒绝了这次观测：' + str(obs.detail, '未知原因'))
            : ('账本拒绝了这次观测（' + str(obs.reason, '未知原因') + '）')
        setStatus({
          text: head + ' ⚠ 余额取到了（' + formatMoneyFixed(balance.amount, { currency: current.currency || '¥' }, 2) + '），'
            + '但**没能记进账本**：' + why + '。这会让「今日/本月」的真实花费一直是 —，请把这句截图给插件作者。',
          kind: 'dtc-err',
        })
      }

      /* ── 选项卡内容 ────────────────────────────────────────────── */

      var pricePane = h('div', { className: 'dtc-sec' },
        h('div', { className: 'dtc-sub-head' },
          h('span', { className: 'dtc-sec-title' }, '模型价格'),
          h('button', {
            type: 'button', className: 'dtc-btn', disabled: !snap.writable,
            onClick: function () {
              var next = models.concat([{ model: '', provider: '', label: '', input: 0, cacheRead: 0, cacheWrite: 0, output: 0, rules: [], promos: [] }])
              edit({ models: next })
              setModelTab(next.length - 1)
            },
          }, '+ 添加模型'),
        ),
        h('div', { className: 'dtc-tabs' }, models.map(function (m, index) {
          return h('button', {
            key: index,
            type: 'button',
            className: 'dtc-tab' + (index === active ? ' dtc-tab-active' : ''),
            onClick: function () { setModelTab(index) },
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
                setModelTab(Math.max(0, active - 1))
              },
            }),
        h('div', { className: 'dtc-actions' },
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
              setModelTab(0)
            },
          }, '恢复 DeepSeek 官方价'),
        ),
        h('div', { className: 'dtc-note' },
          '峰谷规则按「一周内循环时段」判定，时区用「显示项」里的时区偏移（默认 +8 北京时间）；'
          + 'DeepSeek 官方口径是周一至周五 09:00–12:00、14:00–18:00 为高峰，其余（含周末与法定节假日）为空闲，'
          + '空闲价 = 高峰价的一半，所以基础价填**空闲价**、规则填 ×2；'
          + '法定节假日全天可用「限时特价」把区间乘数设为 1（或直接写覆盖价）来单独处理。'),
      )

      var balancePane = h(BalanceCard, {
        current: current, edit: edit, writable: snap.writable, disabled: !snap.writable,
        pendingApiKey: pendingApiKey, setPendingApiKey: setPendingApiKey,
      })

      var recordsPane = h(RecordsCard, {
        current: current, edit: edit, writable: snap.writable, disabled: !snap.writable,
      })

      var displayPane = h(DisplayCard, {
        current: current, edit: edit, writable: snap.writable, disabled: !snap.writable,
        priceCfgForPreview: current,
      })

      var panes = { price: pricePane, balance: balancePane, records: recordsPane, display: displayPane }

      /**
       * 每个选项卡**右上角**的保存区（用户 2026-10-05 要求）。
       *
       * 为什么不再做成底部粘性黑条：用户反馈「两个按钮在黑条上、高度不居中，很丑」。
       * 现在它只是面板头部里一个普通的行内容器（无背景、无定位），
       * 用 `align-items:center` 对齐，状态文字占固定位宽避免按钮跳动。
       */
      function saveActions() {
        return h('div', { className: 'dtc-pane-actions' },
          h('span', { className: 'dtc-status ' + status.kind }, status.text),
          h('button', {
            type: 'button', className: 'dtc-btn', disabled: !dirty,
            onClick: function () { setDraft(null); setStatus({ text: '已放弃未保存的修改。', kind: '' }) },
          }, '放弃修改'),
          h('button', {
            type: 'button', className: 'dtc-btn dtc-btn-primary', disabled: !snap.writable || !dirty,
            onClick: save,
            title: '保存本页全部设置（价格表 / 余额来源 / 记账 / 显示项）',
          }, dirty ? '保存全部设置' : '已保存'),
        )
      }

      return h('div', { className: 'dtc-page' },
        h('div', { className: 'dtc-sec' },
          h('div', { className: 'dtc-sec-title' }, '每轮花费'),
          h('div', { className: 'dtc-note' },
            '在每个已完成回合的下方显示这一轮的花费金额，并在输入框下方汇总余额、本月、今日与当前会话的花费。'
            + '金额按价格表**实时计算**：token 用量由宿主折叠会话事件得到，所以你事后修改价格，'
            + '所有历史回合的金额会立刻跟着更正。'),
          snap.message ? h('div', { className: 'dtc-status dtc-warn' }, snap.message) : null,
          /* 存储通道状态**必须可见**：设置存进浏览器时，宿主读不到余额来源，
             汇总行的「余额」会永远显示 —（2026-10-06 的真实 bug）。 */
          snap.status === 'ready' && snap.source === 'host'
            ? h('div', { className: 'dtc-note' },
              '存储：服务端配置（写入 profile 的 cordis.patch.yml，宿主立刻可读）。')
            : h('div', { className: 'dtc-status dtc-warn' },
              '存储：只在本浏览器（localStorage）—— 宿主读不到这份配置，余额会显示 —。'
              + (snap.status === 'loading' ? '设置服务还在连接中…' : '')
              + '请稍后刷新页面；若一直如此，把这一行截图给插件作者。'),
        ),

        /* 顶部横栏：点哪一栏就切到哪个选项卡。 */
        h('div', { className: 'dtc-tabbar', role: 'tablist' }, SETTINGS_TABS.map(function (item) {
          return h('button', {
            key: item.key,
            type: 'button',
            role: 'tab',
            'aria-selected': tab === item.key,
            className: 'dtc-tabbar-item' + (tab === item.key ? ' dtc-tabbar-active' : ''),
            onClick: function () { setTab(item.key) },
          }, item.label)
        })),

        /* 选项卡标题行：左边是当前选项卡名，右边是保存动作。 */
        h('div', { className: 'dtc-pane-head' },
          h('span', { className: 'dtc-pane-title' }, (panes[tab] ? (SETTINGS_TABS.filter(function (x) { return x.key === tab })[0] || {}).label : '') || ''),
          saveActions(),
        ),

        h('div', { className: 'dtc-pane', role: 'tabpanel' }, panes[tab] || pricePane),
      )
    }

    /* ──────────────────── 设置页卡片 2：账户与余额 ──────────────────── */

    /** 调一次宿主 JSON 端点；失败回调不抛错（设置页不能因为宿主没起来就崩）。 */
    function hostCall(path, options, onDone) {
      if (typeof fetch !== 'function') {
        onDone({ ok: false, reason: 'no-fetch', detail: '当前环境没有 fetch' })
        return
      }
      var init = { credentials: 'same-origin', headers: { Accept: 'application/json' } }
      if (options && options.method) init.method = options.method
      if (options && options.body !== undefined) {
        init.method = init.method || 'POST'
        init.headers = { Accept: 'application/json', 'Content-Type': 'application/json' }
        init.body = JSON.stringify(options.body)
      }
      fetch(path, init).then(function (response) {
        return response.json().catch(function () { return { ok: false, reason: 'bad-json' } })
      }).then(function (payload) {
        onDone(payload && typeof payload === 'object' ? payload : { ok: false, reason: 'bad-payload' })
      }).catch(function (err) {
        onDone({ ok: false, reason: 'network', detail: err && err.message ? err.message : String(err) })
      })
    }

    /** 适配器下拉的选项（与 lib/balance.js 的 ADAPTERS 保持同一份 id 清单）。 */
    var ADAPTER_CHOICES = [
      ['none', '该 provider 没有余额接口（只探活）'],
      ['deepseek', 'DeepSeek 官方'],
      ['openrouter', 'OpenRouter'],
      ['moonshot-cn', 'Kimi / Moonshot（国内）'],
      ['moonshot-ai', 'Kimi / Moonshot（国际）'],
      ['stepfun', '阶跃星辰 StepFun'],
      ['novita', 'Novita AI'],
      /* 智谱 GLM 是**两套互不相通的接口**（2026-10-06 实测）：Coding Plan 订阅账号只能查「额度」，
         其余账号只能查「现金余额」，选错就是「当前用户不存在coding plan」。
         额度型会在这种情况下自动改查余额型，所以不确定自己是哪种时选「额度」也不会卡住。 */
      ['zhipu', '智谱 GLM（Coding Plan 额度；非订阅账号自动改查余额）'],
      ['zai', 'z.ai（Coding Plan 额度；非订阅账号自动改查余额）'],
      ['zhipu-balance', '智谱 GLM（标准 API 现金余额）'],
      ['zai-balance', 'z.ai（标准 API 现金余额）'],
      ['kimi-coding', 'Kimi Coding（订阅额度）'],
      ['minimax', 'MiniMax Coding（订阅额度）'],
      ['openai-compatible', 'OpenAI 兼容中转站（余额）'],
    ]
    /** 每个适配器建议的凭据名（选了适配器就自动填，用户可改）。 */
    var ADAPTER_KEYREF = {
      deepseek: 'DEEPSEEK_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
      'moonshot-cn': 'MOONSHOT_API_KEY',
      'moonshot-ai': 'MOONSHOT_INTL_API_KEY',
      stepfun: 'STEPFUN_API_KEY',
      novita: 'NOVITA_API_KEY',
      zhipu: 'ZHIPU_API_KEY',
      zai: 'ZHIPU_INTL_API_KEY',
      'zhipu-balance': 'ZHIPU_API_KEY',
      'zai-balance': 'ZHIPU_INTL_API_KEY',
      'kimi-coding': 'KIMI_CODING_KEY',
      minimax: 'MINIMAX_API_KEY',
      'openai-compatible': 'CUSTOM_API_KEY',
    }

    function BalanceCard(props) {
      var current = props.current
      var edit = props.edit
      var disabled = props.disabled
      var sources = current.balanceSources
      var linePair = React.useState({ index: -1, kind: '', text: '' })
      var lineState = linePair[0]
      var setLineState = linePair[1]
      var credPair = React.useState(null)
      var credInfo = credPair[0]
      var setCredInfo = credPair[1]
      var revealPair = React.useState(-1)
      var reveal = revealPair[0]
      var setReveal = revealPair[1]
      /* 待保存的密钥由**父组件**（SettingsPage）持有，跟着右上角那一个保存按钮一起提交 ——
         这样「来源配置」与「密钥」不会各存一半（2026-10-05 修）。 */
      var draftKey = props.pendingApiKey || ''
      var setDraftKey = props.setPendingApiKey

      function setSource(index, patch) {
        var next = sources.slice()
        next[index] = Object.assign({}, next[index], patch)
        edit({ balanceSources: next })
      }
      function setLine(index, kind, text) {
        setLineState({ index: index, kind: kind, text: text })
      }

      /** 测试连接：用**草稿参数**，不保存配置、不写凭据。 */
      function testConnection(index) {
        var source = sources[index]
        setLine(index, 'dtc-warn', '测试中…')
        hostCall('/dsh-turn-price/test-connection', {
          body: {
            adapter: source.adapter,
            baseUrl: source.baseUrl,
            label: source.label,
            credentialRef: source.credentialRef,
            timeoutMs: current.balanceTimeoutMs,
            currency: current.currency,
          },
        }, function (payload) {
          if (payload.ok) {
            /* 币种以宿主/适配器给的为准，其次才是本页配置 —— 两边都空才用 ¥。 */
            var currency = payload.currency || current.currency || '¥'
            var extra = payload.kind === 'quota'
              ? '（额度型' + (payload.windows && payload.windows.length ? '：' + payload.windows.map(function (w) { return w.label + ' 剩 ' + Math.round((w.percent || 0) * 10) / 10 + '%' }).join('、') + '）' : '）')
              : '：' + formatMoneyFixed(payload.amount, { currency: currency }, 2) + extra
            setLine(index, 'dtc-ok', '连接成功' + extra)
          } else {
            setLine(index, 'dtc-err', '失败：' + str(payload.reasonText, failureTextOf(payload.reason)))
          }
        })
      }

      /** 保存密钥已并入右上角的「保存全部设置」；这里只保留「查看密钥状态」。 */
      function describeRef(ref) {
        if (!ref) return
        hostCall('/dsh-turn-price/credentials', { body: { action: 'describe', ref: ref } }, function (payload) {
          setCredInfo(payload.ok ? payload : { ref: ref, configured: false, reason: payload.reason })
        })
      }

      return h('div', { className: 'dtc-sec' },
        h('div', { className: 'dtc-sub-head' },
          h('span', { className: 'dtc-sec-title' }, '账户与余额'),
          h('button', {
            type: 'button', className: 'dtc-btn', disabled: disabled,
            onClick: function () {
              edit({ balanceSources: sources.concat([{ id: '', label: '', adapter: 'deepseek', providerIds: [], credentialRef: ADAPTER_KEYREF.deepseek, baseUrl: '', enabled: true }]) })
            },
          }, '+ 添加来源'),
          h('button', {
            type: 'button', className: 'dtc-btn', disabled: disabled,
            onClick: function () {
              hostCall('/dsh-turn-price/refresh', { method: 'POST', body: {} }, function (payload) {
                if (payload.ok) setLine(-1, 'dtc-ok', '余额已刷新')
                else setLine(-1, 'dtc-err', '刷新失败：' + str(payload.reasonText, payload.reason))
              })
            },
          }, '立即刷新余额'),
        ),
        h('div', { className: 'dtc-note' },
          '填 API key 后点「测试连接」确认能取到余额；**密钥只写不读回**，存在 DSH 的凭据库里，不写进配置文件。'
          + '「匹配的 provider id」留空表示：如果只配了一个来源就用它。'),
        sources.length === 0
          ? h('div', { className: 'dtc-note' }, '还没有配置任何余额来源：汇总行里的「余额」会显示 —。')
          : null,
        sources.map(function (source, index) {
          return h('div', { key: index, className: 'dtc-card' },
            h('div', { className: 'dtc-inline' },
              h('label', { className: 'dtc-check' },
                h('input', {
                  type: 'checkbox', checked: source.enabled, disabled: disabled,
                  onChange: function (e) { setSource(index, { enabled: e.target.checked }) },
                }), '启用'),
              h(TextInput, { value: source.label, wide: true, disabled: disabled, placeholder: '名称（显示用）', onChange: function (v) { setSource(index, { label: v }) } }),
              h('select', {
                className: 'dtc-input dtc-input-wide', value: source.adapter, disabled: disabled,
                onChange: function (e) {
                  var adapter = e.target.value
                  setSource(index, { adapter: adapter, credentialRef: ADAPTER_KEYREF[adapter] || '' })
                  setReveal(-1)
                },
              }, ADAPTER_CHOICES.map(function (pair) {
                return h('option', { key: pair[0], value: pair[0] }, pair[1])
              })),
              h('button', {
                type: 'button', className: 'dtc-btn', disabled: disabled,
                onClick: function () { var next = sources.slice(); next.splice(index, 1); edit({ balanceSources: next }) },
              }, '删除'),
            ),
            h('div', { className: 'dtc-inline' },
              h('span', { className: 'dtc-note' }, '匹配 provider id'),
              h(TextInput, {
                value: (source.providerIds || []).join(','), wide: true, disabled: disabled,
                placeholder: 'deepseek-official,deepseek',
                onChange: function (v) {
                  setSource(index, { providerIds: v.split(',').map(function (s) { return s.trim() }).filter(function (s) { return s !== '' }) })
                },
              }),
              h('span', { className: 'dtc-note' }, '凭据名'),
              h(TextInput, {
                value: source.credentialRef, wide: true, disabled: disabled, placeholder: 'DEEPSEEK_API_KEY',
                onChange: function (v) { setSource(index, { credentialRef: v }); setReveal(-1) },
              }),
            ),
            h('div', { className: 'dtc-inline' },
              h('span', { className: 'dtc-note' }, 'Base URL'),
              h(TextInput, {
                value: source.baseUrl, wide: true, disabled: disabled, placeholder: '仅 OpenAI 兼容中转站需要',
                onChange: function (v) { setSource(index, { baseUrl: v }) },
              }),
              h('button', {
                type: 'button', className: 'dtc-btn', disabled: disabled,
                onClick: function () { testConnection(index) },
              }, '测试连接'),
              h('button', {
                type: 'button', className: 'dtc-btn', disabled: disabled,
                onClick: function () { describeRef(source.credentialRef) },
              }, '查看密钥状态'),
              h('button', {
                type: 'button', className: 'dtc-btn', disabled: disabled,
                onClick: function () { setReveal(reveal === index ? -1 : index) },
              }, '替换密钥'),
            ),
            /* 密钥输入框：**只在点了「替换密钥」后出现**，并且永远是空的。
               保存后立刻清空，绝不回显（§12 的「只写」要求）。 */
            reveal === index
              ? h('div', { className: 'dtc-inline' },
                h('span', { className: 'dtc-note' }, '新密钥'),
                h('input', {
                  className: 'dtc-input dtc-input-full', type: 'password', value: draftKey,
                  placeholder: '粘贴新密钥后点右上角「保存全部设置」',
                  onChange: function (e) { setDraftKey(e.target.value) },
                }),
              )
              : null,
            lineState.index === index && lineState.text
              ? h('div', { className: 'dtc-status ' + lineState.kind }, lineState.text)
              : null,
          )
        }),
        credInfo
          ? h('div', { className: 'dtc-status ' + (credInfo.configured ? 'dtc-ok' : 'dtc-warn') },
            (credInfo.ref || '') + '：' + (credInfo.configured ? '已配置' : '未配置')
            + (credInfo.source ? ' · 来源 ' + credInfo.source : '')
            + (credInfo.writable === false ? ' · 只读（被环境变量遮蔽）' : ''))
          : null,
        lineState.index === -1 && lineState.text
          ? h('div', { className: 'dtc-status ' + lineState.kind }, lineState.text)
          : null,
        h('div', { className: 'dtc-grid' },
          h(Field, { label: '刷新间隔（秒）' },
            h(NumberInput, { step: '10', min: '60', value: current.balanceRefreshSeconds, disabled: disabled, onChange: function (v) { edit({ balanceRefreshSeconds: v === '' ? 300 : Math.round(num(v, 300)) }) } })),
          h(Field, { label: '超时（毫秒）' },
            h(NumberInput, { step: '500', min: '1000', value: current.balanceTimeoutMs, disabled: disabled, onChange: function (v) { edit({ balanceTimeoutMs: v === '' ? 8000 : Math.round(num(v, 8000)) }) } })),
        ),
        /* 密钥不再单独设按钮：它在右上角的「保存全部设置」里**与来源配置一起提交**。
           这样不会出现「密钥存了、来源没存」（2026-10-05 用户报的 bug）。 */
        h('div', { className: 'dtc-note' },
          '凭据名默认就是模型在用的那把密钥（如 DEEPSEEK_API_KEY）：余额**只读**它，模型换密钥后余额自动跟着换。'
          + '「替换密钥」写入时，若这个名字是模型 provider 在用的密钥，宿主会**自动改道**存成余额专用密钥'
          + '（TURN_COST_BALANCE_*），绝不会覆盖模型密钥 —— 2026-10-06 就是因为这里覆盖了模型密钥，'
          + '导致对话直接报「API 密钥无效」。'),
        draftKey !== ''
          ? h('div', { className: 'dtc-note' }, '已填入新密钥（不会回显）。点右上角「保存全部设置」会同时保存来源配置与密钥。')
          : null,
      )
    }

    /**
     * 失败分类 → 文案（客户端兜底用）。
     *
     * ⚠️ 这是 `lib/balance.js` 的 `FAILURE_TEXT` 的**镜像**（客户端半体不能 import
     * 宿主模块）。两份必须同步：改任何一份就把两边的 `FAILURE_TEXT_VERSION` 一起 +1 ——
     * `tools/test-balance-adapters.mjs` 会断言两侧版本号相等。
     */
    var FAILURE_TEXT_VERSION = 4

    function failureTextOf(reason) {
      var map = {
        'no-key': '没有配置密钥',
        'no-balance-api': '该 provider 没有余额接口',
        'no-base-url': '需要填写 Base URL',
        'no-coding-plan': '这个账号没有 GLM Coding Plan 订阅，额度接口不可用',
        /* 宿主这一刻取不到凭证服务（重载窗口）—— 与「没配密钥」必须分开说，且可自愈。 */
        'no-credentials-service': '宿主凭据服务暂时不可用（会自动重试）',
        unauthorized: '密钥无效（401）',
        forbidden: '无权访问（403）',
        'not-found': '接口不存在（404，可能是 Base URL 不对）',
        'rate-limited': '请求过于频繁（429）',
        server: '服务端错误（5xx）',
        timeout: '请求超时',
        network: '网络不可达（或宿主未连接）',
        shape: '返回结构不符合预期',
        unknown: '未知错误',
      }
      return map[reason] || '错误：' + String(reason)
    }

    /* ──────────────────── 设置页卡片 3：消费记录 ──────────────────── */

    /* ──────────────────── 消费日历（用户 2026-10-05 要求）────────────────────
       需求原文：一格一天，格子的颜色由当天花费决定，花得越多颜色越深；今天单独一个颜色；
       手工校正也放这里，点某天的格子就能改这一天的消费。

       数据源：宿主 `/dailty.json` → `/daily.json?month=YYYY-MM`，给的是
         · `days[]`  —— 逐天真实观测（`amountUnits` / `missing` / `partialDay` / `needsReview` / `revision`）
         · `turns[]` —— 该月全部估算轮次，客户端用**同一价格引擎逐轮计价**（峰谷按各自时刻）

       显示口径（已与用户确认）：
         · **真实消费为主**：有观测就用观测值上色；没观测但当天有估算 → 只标一个小点提示
         · **今天用单独强调色**（主色描边 + 加粗），不靠填充深浅
         · **「无观测」与「消费 0 元」必须一眼可分**（决策 #7）：前者虚线边+透明底，后者实底最浅档
       颜色分级只用语义变量，且都是 `.ref` 里核实过存在的名字（tools/verify-theme-vars.mjs）。 */

    var CAL_DOW = ['一', '二', '三', '四', '五', '六', '日']

    /** `YYYY-MM-DD` → 该月第几天（1–31）；解析失败返回 0。 */
    function dayNumber(dateKey) {
      var n = Number(String(dateKey).slice(8, 10))
      return Number.isFinite(n) ? n : 0
    }

    /** 月份偏移：`2026-10` + (-1) → `2026-09`。 */
    function shiftMonth(monthKey, delta) {
      var year = Number(String(monthKey).slice(0, 4))
      var month = Number(String(monthKey).slice(5, 7))
      if (!Number.isFinite(year) || !Number.isFinite(month)) return monthKey
      var total = year * 12 + (month - 1) + delta
      var nextYear = Math.floor(total / 12)
      var nextMonth = total - nextYear * 12 + 1
      return String(nextYear) + '-' + (nextMonth < 10 ? '0' : '') + String(nextMonth)
    }

    /**
     * 金额 → 深浅档位 0–4。
     * 分档按**当月最大值**归一（自适应：花得少的月份也能看出层次），
     * 全部为 0 时统一落在第 0 档。
     */
    function depthLevel(amount, maxAmount) {
      if (!(amount > 0)) return 0
      if (!(maxAmount > 0)) return 1
      var ratio = amount / maxAmount
      if (ratio <= 0.25) return 1
      if (ratio <= 0.5) return 2
      if (ratio <= 0.75) return 3
      return 4
    }

    /**
     * 月历网格。**数据由父组件（RecordsCard）持有**，这样「点某天的详情面板」
     * 与「日历格子」用的是同一份数据，不会各取一份而对不上。
     */
    function CalendarGrid(props) {
      var cfg = props.cfg
      var data = props.data
      var decimals = props.decimals
      var selected = props.selected
      var canPrev = props.canPrev
      var canNext = props.canNext
      var onPick = props.onPick
      var onNav = props.onNav

      /* 逐天真实金额（微单位 → 元）+ 该天金额的**显示文本**（多币种并排）。
         多币种的那一天 `amountUnits` 是 null（宿主拒绝跨币种相加），
         所以格子上的数字退化成第一组币种，完整金额在提示与详情里并排给出。 */
      var byDay = {}
      var maxAmount = 0
      for (var i = 0; i < data.days.length; i++) {
        var item = data.days[i]
        var text = aggregateAmountText(item, cfg, decimals)
        var amount = item.amountUnits === null || item.amountUnits === undefined
          ? null
          : Number(item.amountUnits) / 100000000
        if (amount === null && item.mixedCurrency === true && Array.isArray(item.byCurrency) && item.byCurrency.length) {
          amount = Number(item.byCurrency[0].amountUnits) / 100000000
        }
        byDay[item.day] = { info: item, amount: amount, text: text }
        if (amount !== null && amount > maxAmount) maxAmount = amount
      }

      /* 每天是否有估算轮次（只用来在格子上点一个小点）。 */
      var hasEstimate = {}
      for (var t = 0; t < data.turns.length; t++) hasEstimate[data.turns[t].day] = true

      /* 排格子：周一为一周第一天；首日之前补空格。 */
      var cells = []
      var firstDay = dayNumber(data.from)
      /* `Date.UTC` 求星期：0=周日，转成「周一为 0」。 */
      var firstWeekday = new Date(Date.UTC(
        Number(data.from.slice(0, 4)), Number(data.from.slice(5, 7)) - 1, firstDay,
      )).getUTCDay()
      var lead = (firstWeekday + 6) % 7
      for (var leadIndex = 0; leadIndex < lead; leadIndex++) cells.push(null)
      for (var d = 0; d < data.days.length; d++) cells.push(data.days[d])

      var head = []
      for (var w = 0; w < 7; w++) head.push(h('div', { key: 'dow' + w, className: 'dtc-cal-dow' }, CAL_DOW[w]))

      var body = cells.map(function (cell, index) {
        if (cell === null) return h('div', { key: 'pad' + index, className: 'dtc-cal-cell dtc-cal-empty' })
        var entry = byDay[cell.day] || { info: cell, amount: null, text: null }
        var isToday = cell.day === data.today
        var classes = ['dtc-cal-cell']
        if (cell.future === true) classes.push('dtc-cal-future')
        /* 「无观测」用虚线空底；「观测到 0 元」用最浅实底 —— 两者必须一眼可分（决策 #7）。 */
        else if (entry.text === null) classes.push('dtc-cal-missing')
        else if (entry.amount === 0) classes.push('dtc-cal-zero')
        else classes.push('dtc-cal-l' + depthLevel(entry.amount, maxAmount))
        if (isToday) classes.push('dtc-cal-today')
        if (selected === cell.day) classes.push('dtc-cal-selected')

        var flags = []
        if (cell.partialDay === true) flags.push('不完整')
        if (cell.needsReview === true) flags.push('待核对')
        if (cell.mixedCurrency === true) flags.push('混合币种')
        if (Array.isArray(cell.unobservedScopes) && cell.unobservedScopes.length) flags.push('有来源未观测')
        var title = cell.day
          + (entry.text === null ? '　无观测' : '　真实消费 ' + entry.text)
          + (hasEstimate[cell.day] ? '　（有估算轮次）' : '')
          + (flags.length ? '　[' + flags.join('·') + ']' : '')

        return h('button', {
          key: cell.day,
          type: 'button',
          className: classes.join(' '),
          title: title,
          disabled: cell.future === true,
          onClick: function () { onPick(cell.day) },
        },
          h('span', { className: 'dtc-cal-day' }, String(dayNumber(cell.day))),
          entry.amount === null || entry.amount === 0
            ? null
            : h('span', { className: 'dtc-cal-amt' }, entry.amount.toFixed(entry.amount < 10 ? 2 : 1)),
          flags.length ? h('span', { className: 'dtc-cal-flag', title: flags.join('　') }, '!') : null,
        )
      })

      /* 图例：把「无观测 / 0 元 / 花得越来越多」三件事讲清楚。 */
      var legend = h('div', { className: 'dtc-cal-legend' },
        h('span', null, '无观测'),
        h('span', { className: 'dtc-cal-swatch dtc-cal-missing' }),
        h('span', null, '0 元'),
        h('span', { className: 'dtc-cal-swatch dtc-cal-zero' }),
        h('span', null, '少'),
        h('span', { className: 'dtc-cal-swatch dtc-cal-l1' }),
        h('span', { className: 'dtc-cal-swatch dtc-cal-l2' }),
        h('span', { className: 'dtc-cal-swatch dtc-cal-l3' }),
        h('span', { className: 'dtc-cal-swatch dtc-cal-l4' }),
        h('span', null, '多'),
        h('span', { className: 'dtc-cal-swatch dtc-cal-today' }),
        h('span', null, '今天'),
      )

      return h('div', { className: 'dtc-cal' },
        h('div', { className: 'dtc-cal-head' },
          h('button', {
            type: 'button', className: 'dtc-cal-nav', disabled: !canPrev,
            title: '上一个月', onClick: function () { onNav(-1) },
          }, '‹ 上月'),
          h('span', { className: 'dtc-cal-title' },
            /* 合计口径 = 各来源余额差值之和；多币种时并排显示（宿主拒绝跨币种相加）。 */
            data.month + '　合计 ' + str(aggregateAmountText(data, cfg, 2), MISSING)
            + (data.mixedCurrency === true ? '（含多种币种）' : '')),
          h('button', {
            type: 'button', className: 'dtc-cal-nav', disabled: !canNext,
            title: '下一个月', onClick: function () { onNav(1) },
          }, '下月 ›'),
        ),
        h('div', { className: 'dtc-cal-grid' }, head.concat(body)),
        legend,
      )
    }

    /** 点某天之后的详情 + 手工校正面板。 */
    function DayDetail(props) {
      var day = props.day
      var cfg = props.cfg
      var decimals = props.decimals
      var data = props.data
      var onClose = props.onClose
      var onChanged = props.onChanged
      var amountPair = React.useState('')
      var amount = amountPair[0]
      var setAmount = amountPair[1]
      var notePair = React.useState('')
      var note = notePair[0]
      var setNote = notePair[1]
      var msgPair = React.useState({ kind: '', text: '' })
      var message = msgPair[0]
      var setMessage = msgPair[1]
      var busyPair = React.useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]

      if (data === null) return null
      var info = null
      for (var i = 0; i < data.days.length; i++) if (data.days[i].day === day) { info = data.days[i]; break }
      if (info === null) return null

      var realText = aggregateAmountText(info, cfg, decimals)

      /* 分来源：多来源下「校正」必须落到具体某一本账上（宿主按 scope 写）。
         只有一本时照旧（不需要用户选）。 */
      var sources = Array.isArray(info.sources) ? info.sources : []
      var observedSources = sources.filter(function (item) { return item && item.observed === true })
      var defaultScope = str(info.correctionScope, observedSources.length ? observedSources[0].scope : '')
      var scopePair = React.useState(defaultScope)
      var scope = scopePair[0]
      var setScope = scopePair[1]
      function revisionFor(scopeKey) {
        for (var k = 0; k < observedSources.length; k++) {
          if (observedSources[k].scope === scopeKey) return observedSources[k].revision
        }
        return info.revision
      }
      function scopeLabel(scopeKey) {
        for (var k = 0; k < sources.length; k++) {
          if (sources[k].scope === scopeKey) return str(sources[k].label, sources[k].scope)
        }
        return scopeKey
      }

      /* 当天估算：该日全部轮次逐轮计价（用同一个价格引擎）。 */
      var dayTurns = []
      for (var t = 0; t < data.turns.length; t++) if (data.turns[t].day === day) dayTurns.push(data.turns[t])
      var priced = priceTurns(dayTurns, cfg)

      function submitCorrection() {
        var text = String(amount).trim()
        if (text === '') { setMessage({ kind: 'dtc-warn', text: '请填写本区间的累计到账金额（没充过就填 0）' }); return }
        var value = Number(text)
        if (!Number.isFinite(value) || value < 0) { setMessage({ kind: 'dtc-warn', text: '到账金额必须是不小于 0 的数字' }); return }
        setBusy(true)
        hostCall('/dsh-turn-price/correction', {
          body: { day: day, credits: value, note: note, scope: scope, revision: revisionFor(scope) },
        }, function (payload) {
          setBusy(false)
          if (payload.ok) {
            setMessage({ kind: 'dtc-ok', text: '已校正 ' + day + '（' + scopeLabel(scope) + '）：该来源当天消费按「期初 + 到账 − 期末」重算' })
            onChanged()
          } else {
            setMessage({ kind: 'dtc-err', text: '校正失败：' + str(payload.reasonText, payload.reason) })
          }
        })
      }

      function clearCorrection() {
        setBusy(true)
        hostCall('/dsh-turn-price/correction', { body: { day: day, clear: true, action: 'reset', scope: scope, revision: revisionFor(scope) } }, function (payload) {
          setBusy(false)
          if (payload.ok) { setMessage({ kind: 'dtc-ok', text: '已撤销 ' + scopeLabel(scope) + ' 在 ' + day + ' 的手工校正' }); onChanged() }
          else setMessage({ kind: 'dtc-err', text: '撤销失败：' + str(payload.reasonText, payload.reason) })
        })
      }

      var status = []
      if (info.missing === true) status.push('无观测')
      if (info.inProgress === true) status.push('观测中')
      if (info.partialDay === true) status.push('数据不完整')
      if (info.needsReview === true) status.push('待核对（当天余额上升过）')
      if (info.mixedCurrency === true) status.push('混合币种')

      return h('div', { className: 'dtc-cal-detail' },
        h('div', { className: 'dtc-cal-detail-title' },
          day + '　' + (status.length ? '[' + status.join('·') + ']' : '[数据完整]'),
          h('button', {
            type: 'button', className: 'dtc-cal-nav',
            style: { marginLeft: '8px' }, onClick: onClose,
          }, '关闭'),
        ),
        h('div', { className: 'dtc-meta' },
          h('div', null, '真实消费（各来源余额观测差值之和）：' + str(realText, MISSING)),
          h('div', null, '估算消费（' + priced.priced + ' 轮 × 当前价格表）：' + (priced.priced === 0 ? '这一天没有估算轮次' : formatMoneyFixed(priced.total, { currency: cfg.currency }, decimals))),
          h('div', null, '校正状态：' + (info.corrected === true ? '已手工校正' : '未校正')),
        ),
        h(MiniTable, {
          head: ['来源', '当天差值', '状态'],
          rows: sourceRows(sources, cfg, decimals),
        }),
        info.missing === true
          ? h('div', { className: 'dtc-note' },
              '这一天没有余额观测记录 —— 插件还没运行，或当天没打开过 DSH。'
              + '按「实时增量、不扫全库回填」的设计，这段历史无法还原（不是消费 0 元）。')
          : null,
        info.mixedCurrency === true
          ? h('div', { className: 'dtc-note' },
              '这一天的来源币种不同：合计按币种分别给出，**不跨币种相加**；格子上的数字只画了第一组（'
              + (info.byCurrency || []).map(function (group) {
                /* 这里**不用** formatMoneyFixed：它会拿配置的显示符号兜底，
                   而多币种场景下把 ISO 码写清楚才是诚实的（USD 不能画成 ¥）。 */
                return str(group.currency, '?') + ' ' + num(group.amount, 0).toFixed(decimals)
              }).join(' / ')
              + '）。')
          : null,
        h('div', { className: 'dtc-inline' },
          observedSources.length > 1
            ? h('span', { className: 'dtc-inline' },
                h('span', { className: 'dtc-note' }, '校正哪个来源'),
                h('select', {
                  className: 'dtc-input', value: scope, disabled: busy,
                  onChange: function (e) { setScope(e.target.value) },
                }, observedSources.map(function (item) {
                  return h('option', { key: item.scope, value: item.scope }, str(item.label, item.scope))
                })))
            : null,
          h('span', { className: 'dtc-note' }, '本区间累计到账（充值）'),
          h(TextInput, { value: amount, disabled: busy, placeholder: '没充过填 0', onChange: setAmount }),
          h(TextInput, { value: note, disabled: busy, wide: true, placeholder: '备注（可选）', onChange: setNote }),
          h('button', {
            type: 'button', className: 'dtc-btn dtc-btn-primary', disabled: busy || info.missing === true || observedSources.length === 0,
            onClick: submitCorrection,
          }, busy ? '提交中…' : '按此重算当天消费'),
          h('button', {
            type: 'button', className: 'dtc-btn', disabled: busy || observedSources.length === 0,
            onClick: clearCorrection,
          }, '撤销校正'),
        ),
        h('div', { className: 'dtc-note' },
          '为什么要填「到账」：当天消费 = 期初余额 + 期间到账 − 期末余额。'
          + '插件只能看到自己观测到的区间，充值不会让消费算错（它已从差值里扣掉），'
          + '但如果当天**观测开始得晚**，早于观测的那段消费就不在期初里，'
          + '这时填上到账额可以由你直接给出当天的真实消费。'
          + (observedSources.length > 1 ? '多来源时校正**只作用于选中的那一个来源**，其余来源照旧。' : '')),
        message.text ? h('div', { className: 'dtc-status ' + message.kind }, message.text) : null,
      )
    }

    function RecordsCard(props) {
      var current = props.current
      var edit = props.edit
      var disabled = props.disabled
      var infoPair = React.useState(null)
      var info = infoPair[0]
      var setInfo = infoPair[1]
      var statePair = React.useState(null)
      var state = statePair[0]
      var setState = statePair[1]
      var msgPair = React.useState({ kind: '', text: '' })
      var message = msgPair[0]
      var setMessage = msgPair[1]
      var confirmPair = React.useState('')
      var confirmText = confirmPair[0]
      var setConfirmText = confirmPair[1]
      /* ── 日历状态（由本组件统一持有，日历与当日详情共用同一份数据）── */
      var calPair = React.useState(null)
      var calendar = calPair[0]
      var setCalendar = calPair[1]
      var calErrPair = React.useState('')
      var calErr = calErrPair[0]
      var setCalErr = calErrPair[1]
      var calMonthPair = React.useState('')
      var calMonth = calMonthPair[0]
      var setCalMonth = calMonthPair[1]
      var boundPair = React.useState({ prev: true, next: true })
      var bounds = boundPair[0]
      var setBounds = boundPair[1]
      var pickedPair = React.useState('')
      var pickedDay = pickedPair[0]
      var setPickedDay = pickedPair[1]

      function loadCalendar(monthKey) {
        var url = '/dsh-turn-price/daily.json' + (monthKey ? '?month=' + encodeURIComponent(monthKey) : '')
        hostCall(url, {}, function (payload) {
          if (!payload.ok) { setCalErr(str(payload.reasonText, payload.reason)); return }
          setCalErr('')
          setCalendar(payload)
          setCalMonth(payload.month)
          /* 不给用户翻到保留期之外（格子会全是「已裁剪」）或未来（还没有数据）。 */
          var todayMonth = String(payload.today).slice(0, 7)
          var keepFromMonth = str(payload.keepFrom, '').slice(0, 7)
          setBounds({
            prev: keepFromMonth === '' || payload.month > keepFromMonth,
            next: payload.month < todayMonth,
          })
        })
      }

      /* 切换月份：清掉当前选中的日子（它不属于新月份了）。 */
      function navCalendar(delta) {
        setPickedDay('')
        loadCalendar(shiftMonth(calMonth, delta))
      }

      React.useEffect(function () { loadCalendar('') }, [])

      React.useEffect(function () {
        hostCall('/dsh-turn-price/state.json', {}, function (payload) {
          if (payload.ok) { setState(payload); setInfo(payload.ledger || null) }
          else setMessage({ kind: 'dtc-err', text: '宿主不可用：' + str(payload.reason, '未知') })
        })
      }, [])

      function refreshLedgerInfo() {
        hostCall('/dsh-turn-price/state.json', {}, function (payload) {
          if (payload.ok) { setState(payload); setInfo(payload.ledger || null) }
        })
      }

      function doClear(what) {
        if (confirmText !== what) {
          setMessage({ kind: 'dtc-warn', text: '危险操作：请先在下面输入要清空的内容（' + what + '）' })
          return
        }
        hostCall('/dsh-turn-price/ledger/clear', { body: { what: what } }, function (payload) {
          if (payload.ok) {
            setConfirmText('')
            setMessage({ kind: 'dtc-ok', text: '已清空 ' + payload.what + '（涉及 ' + payload.cleared + ' 天）' })
            refreshLedgerInfo()
          } else {
            setMessage({ kind: 'dtc-err', text: '清空失败：' + str(payload.detail, payload.reason) })
          }
        })
      }

      function exportLedger() {
        hostCall('/dsh-turn-price/ledger?export=1', {}, function (payload) {
          if (!payload.ok) {
            setMessage({ kind: 'dtc-err', text: '导出失败：' + str(payload.reason) })
            return
          }
          try {
            /* 多来源之后导出**全部本**：只报当前本的天数会让用户以为另一个账户的记录没导出。 */
            var exportedBooks = payload.books || {}
            var exportedDays = 0
            for (var scopeKey in exportedBooks) {
              if (Object.prototype.hasOwnProperty.call(exportedBooks, scopeKey)) {
                exportedDays += Object.keys((exportedBooks[scopeKey] || {}).days || {}).length
              }
            }
            if (exportedDays === 0) exportedDays = Object.keys(payload.days || {}).length
            setMessage({ kind: 'dtc-ok', text: '已生成日账 JSON（' + exportedDays + ' 天 × ' + Object.keys(exportedBooks).length + ' 本账）；已在控制台输出，可直接复制' })
            if (typeof console !== 'undefined' && console.log) console.log('[dsh-turn-price] 日账导出', JSON.stringify(payload))
          } catch (err) {
            setMessage({ kind: 'dtc-warn', text: '导出内容已生成，但控制台输出失败' })
          }
        })
      }

      var bytes = info && typeof info.bytes === 'number' ? info.bytes : 0
      return h('div', { className: 'dtc-sec' },
        h('div', { className: 'dtc-sub-head' },
          h('span', { className: 'dtc-sec-title' }, '消费记录'),
          h('button', { type: 'button', className: 'dtc-btn', onClick: refreshLedgerInfo }, '刷新状态'),
        ),
        h('div', { className: 'dtc-note' },
          '真实花费 = 余额观测的差值（每 300 秒一次，可在上面改）；估算是本插件运行期间按轮累计的 token × 单价。'
          + '两者都会写进本地账本文件，**不会上传**。'),
        h('div', { className: 'dtc-grid' },
          h(Field, { label: '保留时长（月）' },
            h(NumberInput, { step: '1', min: '1', max: '24', value: current.ledgerRetentionMonths, disabled: disabled, onChange: function (v) { edit({ ledgerRetentionMonths: v === '' ? 12 : Math.round(num(v, 12)) }) } })),
          h(Field, { label: '每月起始日' },
            h(NumberInput, { step: '1', min: '1', max: '31', value: current.monthStartDay, disabled: disabled, onChange: function (v) { edit({ monthStartDay: v === '' ? 1 : Math.round(num(v, 1)) }) } })),
        ),
        h('div', { className: 'dtc-note' }, '「每月起始日」按当月天数自动钳制（填 31 时，2 月按 28/29、4 月按 30）。改完保存即立即重算。'),
        info
          ? h('div', { className: 'dtc-meta' },
            h('div', null, '账本文件体积：' + (bytes / 1024).toFixed(1) + ' KB（' + bytes + ' 字节）'),
            h('div', null, '当前账本：' + (info.active || '（还没有数据）') + '　保留期内的最早日期：' + str(info.keepFrom, '—')),
            h('div', null, '下一条将被裁剪的日期：' + str(info.nextPruneDay, '（没有需要裁剪的）')),
            h('div', null, '账本里的天数：' + num(info.dayCount, 0) + '　保留 ' + num(info.retentionMonths, 12) + ' 个月'),
            info.recovered ? h('div', null, '⚠️ 上次启动时账本文件损坏，已备份并重建：' + str(info.recovered.backupPath, '')) : null,
            info.lastError ? h('div', null, '⚠️ 最近一次账本写入错误：' + str(info.lastError)) : null,
          )
          : h('div', { className: 'dtc-note' }, '（宿主未连接，读不到账本状态）'),
        state && state.todayReal
          ? h('div', { className: 'dtc-meta' },
            h('div', null, '今天是否观测中：' + (state.todayReal.inProgress ? '是' : '否')
              + '　观测起点 ' + formatClock(state.todayReal.observedFromMs, current)),
            h('div', null, '今日真实消费（各来源差值之和）：' + str(aggregateAmountText(state.todayReal, current, 2), MISSING)
              + (state.todayReal.partialDay ? '（不完整）' : '')),
            Array.isArray(state.todayReal.sources) && state.todayReal.sources.length
              ? h('div', null, '计入的来源：' + state.todayReal.sources.map(function (item) {
                return str(item.label, item.scope) + (item.observed === true ? ' ✓' : '（未观测）')
              }).join('　'))
              : null,
          )
          : null,
        /* ── 消费日历（用户 2026-10-05 要求：一格一天、颜色越深花得越多、
              今天单独强调色、点格子直接改当天消费）─────────────────────── */
        h('div', { className: 'dtc-sub-head' },
          h('span', { className: 'dtc-sec-title' }, '消费日历'),
          h('button', {
            type: 'button', className: 'dtc-btn', disabled: disabled,
            onClick: function () { loadCalendar(calMonth) },
          }, '刷新日历'),
        ),
        calErr !== ''
          ? h('div', { className: 'dtc-note' }, '日历读不到数据：' + calErr)
          : (calendar === null
              ? h('div', { className: 'dtc-note' }, '正在读取日账…')
              : h('div', null,
                  h(CalendarGrid, {
                    cfg: current,
                    data: calendar,
                    decimals: 2,
                    selected: pickedDay,
                    canPrev: bounds.prev,
                    canNext: bounds.next,
                    onPick: function (day) { setPickedDay(pickedDay === day ? '' : day) },
                    onNav: navCalendar,
                  }),
                  pickedDay === ''
                    ? h('div', { className: 'dtc-note' }, '点任意一天的格子可以看当天明细（含分来源差值），并在那里手工校正。')
                    : h(DayDetail, {
                        /* `key` = 选中的日期：换一天就重挂载，避免「校正哪个来源」的选择残留到另一天。 */
                        key: pickedDay,
                        day: pickedDay,
                        cfg: current,
                        decimals: 2,
                        data: calendar,
                        onClose: function () { setPickedDay('') },
                        onChanged: function () { loadCalendar(calMonth); refreshLedgerInfo() },
                      }),
                )),
        h('div', { className: 'dtc-inline' },
          h('button', { type: 'button', className: 'dtc-btn', onClick: exportLedger }, '导出日账 JSON'),
          h('button', { type: 'button', className: 'dtc-btn', disabled: disabled, onClick: function () { doClear('estimates') } }, '清空估算账'),
          h('button', { type: 'button', className: 'dtc-btn', disabled: disabled, onClick: function () { doClear('all') } }, '清空全部记录'),
        ),
        h('div', { className: 'dtc-inline' },
          h('span', { className: 'dtc-note' }, '危险操作确认文字（要清空估算账就输入 estimates，清空全部记录就输入 all，输入后上面的按钮才会执行）'),
          h(TextInput, { value: confirmText, disabled: disabled, placeholder: 'estimates 或 all', onChange: setConfirmText }),
        ),
        message.text ? h('div', { className: 'dtc-status ' + message.kind }, message.text) : null,
        h('div', { className: 'dtc-note' },
          '关于「充值会不会算错消费」：**不会**。当天消费 = 期初余额 − 期末余额，充值带来的上升在差值里被自动抵消，'
          + '所以有充值的那天数字依然正确。真正会让数字偏小的情况是**观测开始得晚** —— '
          + '插件开始观测之前那段消费不在期初里（这种日子在日历上会标「数据不完整」）。'
          + '那时点当天的格子，填入本区间累计到账额，就能把当天消费校正过来。'),
      )
    }

    /* ──────────────────── 设置页卡片 4：显示项 ──────────────────── */

    function DisplayCard(props) {
      var current = props.current
      var edit = props.edit
      var disabled = props.disabled
      var order = sanitizeDisplayOrder(current.displayOrder)
      var items = sanitizeDisplayItems(current.displayItems)

      function move(index, delta) {
        var next = order.slice()
        var target = index + delta
        if (target < 0 || target >= next.length) return
        var tmp = next[index]
        next[index] = next[target]
        next[target] = tmp
        edit({ displayOrder: next })
      }

      /* 用一个「假宿主」的状态渲染一遍预览，让用户看到 5 段的实际样子。 */
      var previewState = {
        ok: true,
        now: Date.now(),
        balance: { known: true, kind: 'balance', amount: 42.17, currency: current.currency, sourceLabel: '示例', at: Date.now() },
        month: {
          from: '2026-03-01', to: '2026-03-31', monthStartDay: current.monthStartDay, amount: 58.3, currency: 'CNY',
          mixedCurrency: false, byCurrency: [{ currency: 'CNY', amount: 58.3, amountUnits: 5830000000, sourceCount: 1, scopes: ['deepseek|demo|CNY'] }],
          sources: [
            { scope: 'deepseek|demo|CNY', label: 'DeepSeek 官方', currency: 'CNY', observed: true, amount: 58.3, observedDays: 5, turnCount: 12 },
            { scope: 'zhipu|demo|CNY', label: '智谱 GLM（标准 API 余额）', currency: 'CNY', observed: true, amount: 0, observedDays: 5, turnCount: 3 },
          ],
          observedDays: 5, missingDays: [], incompleteDays: [], needsReviewDays: [], unobservedScopes: [], hasGap: false, hasAnyObservation: true, days: [],
        },
        todayReal: {
          amount: 3.42, currency: 'CNY', partialDay: false, inProgress: true, needsReview: false,
          observedFromMs: Date.now() - 3600000, observedToMs: Date.now(), openingBalance: 45.59, currentBalance: 42.17,
          observedDecrease: 3.42, observedIncrease: 0, corrected: false, mixedCurrency: false,
          byCurrency: [{ currency: 'CNY', amount: 3.42, amountUnits: 342000000, sourceCount: 2, scopes: ['deepseek|demo|CNY', 'zhipu|demo|CNY'] }],
          unobservedScopes: [], duplicates: [],
          sources: [
            { scope: 'deepseek|demo|CNY', label: 'DeepSeek 官方', currency: 'CNY', observed: true, amount: 3.42, openingUnits: 4559000000, lastUnits: 4217000000, partialDay: false, needsReview: false, corrected: false, firstAt: Date.now() - 3600000, lastAt: Date.now(), turnCount: 3 },
            { scope: 'zhipu|demo|CNY', label: '智谱 GLM（标准 API 余额）', currency: 'CNY', observed: true, amount: 0, openingUnits: 189984294, lastUnits: 189984294, partialDay: false, needsReview: false, corrected: false, firstAt: Date.now() - 3600000, lastAt: Date.now(), turnCount: 1 },
          ],
        },
        todayTurns: [{ k: 'x:1', t: Date.now(), p: 'deepseek-official', m: 'deepseek-flash', i: 1000000, o: 100000, cr: 0, cw: 0 }],
        monthTurns: [],
      }
      var previewUsage = { ok: true, complete: true, turnCount: 1, turns: [{ turn: 1, endSeq: 1, endTime: Date.now(), reason: 'completed', interrupted: false, routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }], route: { provider: 'deepseek-official', model: 'deepseek-flash' }, buckets: { uncachedInputTokens: 500000, outputTokens: 50000, cacheReadTokens: 0, cacheWriteTokens: 0 } }], children: [], childrenSummary: { count: 0, priced: 0, unpriced: 0, unpricedReasons: [], truncated: false, errors: [] } }
      var preview = buildSummary(current, previewState, previewUsage)

      return h('div', { className: 'dtc-sec' },
        h('div', { className: 'dtc-sec-title' }, '显示项'),
        h('div', { className: 'dtc-grid' },
          h('label', { className: 'dtc-check' },
            h('input', { type: 'checkbox', checked: current.enabled, disabled: disabled, onChange: function (e) { edit({ enabled: e.target.checked }) } }),
            '显示每轮花费与汇总行'),
          h(Field, { label: '货币符号' },
            h(TextInput, { value: current.currency, disabled: disabled, onChange: function (v) { edit({ currency: v }) } })),
          h(Field, { label: '明细小数位' },
            h(NumberInput, { step: '1', min: '0', max: '8', value: current.decimals, disabled: disabled, onChange: function (v) { edit({ decimals: v === '' ? 4 : Math.round(num(v, 4)) }) } })),
          h(Field, { label: '汇总行小数位' },
            h(NumberInput, { step: '1', min: '0', max: '4', value: current.summaryDecimals, disabled: disabled, onChange: function (v) { edit({ summaryDecimals: v === '' ? 2 : Math.round(num(v, 2)) }) } })),
          h(Field, { label: '时区偏移' },
            h(NumberInput, { step: '0.5', value: current.tzOffset, disabled: disabled, onChange: function (v) { edit({ tzOffset: v === '' ? 8 : num(v, 8) }) } })),
          h(Field, { label: '每多少 tokens' },
            h(NumberInput, { step: '1', value: current.perTokens, disabled: disabled, onChange: function (v) { edit({ perTokens: v === '' ? 1000000 : num(v, 1000000) }) } })),
          h(Field, { label: '未配置的模型' },
            h('select', {
              className: 'dtc-input dtc-input-wide', value: current.unknownModel, disabled: disabled,
              onChange: function (e) { edit({ unknownModel: e.target.value }) },
            },
              h('option', { value: 'hide' }, '不显示金额'),
              h('option', { value: 'fallback' }, '用兜底价计算'))),
          h(Field, { label: '估算徽标文案' },
            h(TextInput, { value: current.estimateBadgeText, disabled: disabled, onChange: function (v) { edit({ estimateBadgeText: v }) } })),
          h(Field, { label: '不完整徽标文案' },
            h(TextInput, { value: current.incompleteBadgeText, disabled: disabled, onChange: function (v) { edit({ incompleteBadgeText: v }) } })),
          h('label', { className: 'dtc-check' },
            h('input', { type: 'checkbox', checked: current.showUpdatedAt, disabled: disabled, onChange: function (e) { edit({ showUpdatedAt: e.target.checked }) } }),
            '显示「更新于 x 分钟前」'),
        ),
        current.unknownModel === 'fallback' ? h('div', { className: 'dtc-grid' },
          h(Field, { label: '兜底 ' + PRICE_LABELS.input }, h(NumberInput, { value: current.fallback.input, disabled: disabled, onChange: function (v) { edit({ fallback: Object.assign({}, current.fallback, { input: num(v, 0) }) }) } })),
          h(Field, { label: '兜底 ' + PRICE_LABELS.cacheRead }, h(NumberInput, { value: current.fallback.cacheRead, disabled: disabled, onChange: function (v) { edit({ fallback: Object.assign({}, current.fallback, { cacheRead: num(v, 0) }) }) } })),
          h(Field, { label: '兜底 ' + PRICE_LABELS.cacheWrite }, h(NumberInput, { value: current.fallback.cacheWrite, disabled: disabled, onChange: function (v) { edit({ fallback: Object.assign({}, current.fallback, { cacheWrite: num(v, 0) }) }) } })),
          h(Field, { label: '兜底 ' + PRICE_LABELS.output }, h(NumberInput, { value: current.fallback.output, disabled: disabled, onChange: function (v) { edit({ fallback: Object.assign({}, current.fallback, { output: num(v, 0) }) }) } })),
        ) : null,
        h('div', { className: 'dtc-note' }, '汇总行的显示顺序（上/下移动）：'),
        h('div', { className: 'dtc-actions' }, order.map(function (key, index) {
          return h('span', { key: key, className: 'dtc-inline' },
            h('label', { className: 'dtc-check' },
              h('input', {
                type: 'checkbox', checked: items[key] === true, disabled: disabled,
                onChange: function (e) {
                  var next = Object.assign({}, items)
                  next[key] = e.target.checked
                  edit({ displayItems: next })
                },
              }), DISPLAY_LABELS[key]),
            h('button', { type: 'button', className: 'dtc-btn', disabled: disabled || index === 0, onClick: function () { move(index, -1) } }, '↑'),
            h('button', { type: 'button', className: 'dtc-btn', disabled: disabled || index === order.length - 1, onClick: function () { move(index, 1) } }, '↓'),
          )
        })),
        h('div', { className: 'dtc-note' }, '预览（用示例数字渲染一遍当前配置）：'),
        h('div', { className: 'dtc-preview' }, preview.segments.map(function (segment, index) {
          var text = segment.quota ? '（额度）' : (segment.text === null ? MISSING : segment.text)
          return (index > 0 ? ' · ' : '') + segment.label + ' ' + text
            + (segment.estimate ? ' [' + segment.badge + ']' : '')
            + (segment.incomplete ? ' [' + segment.incompleteBadge + ']' : '')
        }).join('')),
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
      /**
       * 服务晚就绪也要接上（`ctx.inject` 在服务出现时回调一次）。
       *
       * 为什么不写进 `inject` 数组：`inject` 缺失会让整个 fiber 停在 pending，
       * 那样连金额行都不显示 —— configForms 只是**设置页的存储通道**，
       * 它不在就退化成浏览器存储，主功能不受影响（见 createStore 的注释）。
       */
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['configForms'], function (scope) {
            try {
              var late = scope && typeof scope.get === 'function' ? scope.get('configForms') : null
              if (late && typeof late.get === 'function') store.attachForm(late.get(SETTINGS_NS))
            } catch (err) { /* 接不上就继续用浏览器存储（有 UI 明示） */ }
          })
        }
      } catch (err) { /* inject 不可用不影响其它功能 */ }
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

      /* 宿主数据源（主路径）。失败不影响轮尾金额：组件会退回客户端求和。 */
      var feed = createUsageFeed()
      USAGE_FEED = feed
      var stateFeed = createStateFeed()
      STATE_FEED = stateFeed
      ctx.effect(function () {
        return function () {
          feed.dispose()
          stateFeed.dispose()
          if (USAGE_FEED === feed) USAGE_FEED = null
          if (STATE_FEED === stateFeed) STATE_FEED = null
        }
      }, 'turn-cost: host feeds')

      /* 汇总行：`conversation.composer.dock`。
         **`order` 是升序**（`dsh-client-ui-slots` 的
         `next.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))`），内置 `stats` 是 `order: 0`：
           · `order < 0` → 我们的行在 stats **上面**（早期实现，理解反了，用户指出过）
           · `order > 0` → 我们的行在 stats **下面**（用户 2026-10-05 更正后的要求） */
      ctx.slots.inject('conversation.composer.dock', function () {
        return ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'turn-cost-summary',
          order: 10,
        }, SummaryRow)
      })

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'turn-cost',
          order: 30,
          label: function () { return '每轮花费' },
        }, function Section() { return h(SettingsPage, null) })
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
      sanitizeBalanceSource: sanitizeBalanceSource,
      sanitizeDisplayItems: sanitizeDisplayItems,
      sanitizeDisplayOrder: sanitizeDisplayOrder,
      DISPLAY_KEYS: DISPLAY_KEYS,
      parseHM: parseHM,
      parseWall: parseWall,
      wallClock: wallClock,
      ruleMatches: ruleMatches,
      promoMatches: promoMatches,
      resolveUnitPrices: resolveUnitPrices,
      findEntry: findEntry,
      computeCost: computeCost,
      addStepUsage: addStepUsage,
      sumStepUsage: sumStepUsage,
      readFoldRoutes: readFoldRoutes,
      resolveTurnInput: resolveTurnInput,
      createUsageFeed: createUsageFeed,
      createStateFeed: createStateFeed,
      SummaryRow: SummaryRow,
      buildSummary: buildSummary,
      priceTurns: priceTurns,
      priceChildren: priceChildren,
      formatMoneyFixed: formatMoneyFixed,
      FAILURE_TEXT_VERSION: FAILURE_TEXT_VERSION,
      failureTextOf: failureTextOf,
      formatRelativeTime: formatRelativeTime,
      formatClock: formatClock,
      summaryAmountText: summaryAmountText,
      /* 多来源聚合的显示口径（tools/test-pricing.mjs 断言：单币种正常、多币种不冒充 ¥）。 */
      aggregateAmountText: aggregateAmountText,
      sourceRows: sourceRows,
      MISSING: MISSING,
      get STATE_FEED() { return STATE_FEED },
      set STATE_FEED(value) { STATE_FEED = value },
      sessionIdOf: sessionIdOf,
      CostTail: CostTail,
      /** 只读出口：测试要读组件选中的数据源。 */
      get USAGE_FEED() { return USAGE_FEED },
      set USAGE_FEED(value) { USAGE_FEED = value },
      USAGE_URL: USAGE_URL,
      formatMoney: formatMoney,
      toMs: toMs,
      readTurnTail: readTurnTail,
      deepseekModel: deepseekModel,
    }
    return module.exports
  },
})
