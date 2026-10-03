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

export const name = 'turn-cost'

/** 宿主半体不依赖任何服务：它只声明 Config 供框架投影成设置表单。 */
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
 * 限时特价：绝对时间区间（按 tzOffset 时区的本地墙上时间），优先级最高。
 * multiplier 与四个覆盖价都可选：覆盖价用 -1 表示「不覆盖，沿用基础价」。
 */
const promoSchema = () =>
  z.object({
    label: z.string().default('限时优惠'),
    /** "YYYY-MM-DDTHH:mm"，空串表示该端不设限。 */
    from: z.string().default(''),
    to: z.string().default(''),
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
    /** 金额显示的小数位数。 */
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
  })
  .volatile()

/**
 * 宿主半体不做任何事：设置表单由框架依据上面的 Config 自动投影，
 * 金额计算全部发生在客户端（token 用量与价格都在浏览器侧可得）。
 */
export function apply() {
  // 故意留空。
}
