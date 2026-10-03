# dsh-turn-price

[![npm version](https://img.shields.io/npm/v/dsh-turn-price.svg)](https://www.npmjs.com/package/dsh-turn-price)
[![license MIT](https://img.shields.io/npm/l/dsh-turn-price.svg)](./LICENSE)
[![dsh-plugin topic](https://img.shields.io/badge/topic-dsh--plugin-2ea44f)](https://github.com/topics/dsh-plugin)
[![DSH](https://img.shields.io/badge/dsh-%3E%3D0.2.0--rc.1%20%3C0.3.0-4176e6)](https://github.com/deepseek-ai/deepseek-harness)

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 Web 界面里，**在每个已完成回合的下方单独一行显示这一轮花了多少钱**，点击可展开明细（各 token 类别的数量 × 单价 = 金额、命中的价格规则、计费时刻）。

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) web plugin that shows **what each turn cost, in CNY**, on its own row under the turn. Click the amount for a breakdown: tokens per category × unit rate = money, which price rule matched, and the billing instant.

金额按当前价格表**实时计算**：token 用量取自 dsh 内置的「本轮用量」，插件不做任何估算，所以你事后修改价格，**所有历史回合的金额会立刻跟着更正** —— 这正是「忘了提前改价」的补救方式。

> 界面上的金额是**预估**，不是账单：它等于 provider 上报的 token 数乘以你本地价格表的单价，实际结算以平台为准。

---

## 安装

本插件是标准的 dsh 组合包（`dsh.bundle.patch` + `dsh.client`），三种地址形式等价：

| 地址形式 | 命令 |
| --- | --- |
| npm 包名 | `dsh plugin --profile <profile> add dsh-turn-price` |
| Git 仓库 | `dsh plugin --profile <profile> add github:littlefish04/dsh-turn-price` |
| 本地目录 / tarball | `dsh plugin --profile <profile> add <绝对路径>` |

也可以在应用内侧边栏的**插件**页用「添加插件」，填入上面任一形式的地址。

- 把 `<profile>` 换成目标 profile 名（桌面版是 `desktop`，`dsh web` 常见 `web`）。
- **装好后需要重启该 profile 才生效**：插件行在启动时确定（桌面应用完全退出后重开，或重启 `dsh web`）。
- 卸载：`dsh plugin --profile <profile> remove dsh-turn-price`。

<details>
<summary>从源码目录安装（开发用）</summary>

```powershell
dsh plugin --profile desktop add "<本仓库的绝对路径>"
```

本插件**没有构建步骤**（`lib/` 既是源码也是发布产物），所以 git 安装不需要 `prepare` 脚本、
也不需要用户在 `pnpm-workspace.yaml` 里批准构建脚本。

</details>

## 它长什么样

每个已完成回合的操作行**上方**多出一行金额（不占用 hover 才出现的操作行）：

![每轮花费行](https://cdn.jsdelivr.net/gh/littlefish04/dsh-turn-price@main/assets/shot-cost-row.png)

> 上图里那一行由四部分组成：`本轮花费` + 金额 `¥0.0874` + 徽标 `限时优惠` + 展开箭头 `▼`。
> 徽标只在命中规则时出现，显示规则名，系数不是 1 时写成 `高峰×2` 这样。

点击金额展开明细：

| 显示项 | 内容 |
| --- | --- |
| 面板标题 | `本轮花费明细` + 合计金额 |
| 模型 | `模型：<provider> / <model>`；一个回合换过模型时附注 `（本轮共 N 个路由，按末次尝试计价）` |
| 计费时刻 | `计费时刻：2026-10-03 19:16（UTC+8，星期六）` |
| 生效价格 | `生效价格：基础价（DeepSeek Flash）`，或 `高峰 ×2` / `限时优惠 ×1` |
| 单价口径 | `单价口径：每 1,000,000 tokens` |
| 明细表 | `类别 / tokens / 单价 / 金额` 四列，之下是 `合计` 行 |

设置 → **每轮花费**：按模型分页签维护价格表，改完保存，**所有历史回合的金额立即重算**。

![设置页：每轮花费](https://cdn.jsdelivr.net/gh/littlefish04/dsh-turn-price@main/assets/shot-settings.png)

## 它是怎么算的

### token 用量来源

复用 dsh 内置的每轮用量，不另起一套：

```
turn.data.get('turn-tail').tokenUsage
  = deriveTurnTokenUsage(events)      // @deepseek-ai/dsh-token-meter/client
  = { uncachedInputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens?, routes? }
```

这与内置「本轮用量」面板读到的是**同一个对象**，因此插件显示的 token 数与面板逐项一致。
该项缺失时（回合未终结、用量不可证）插件不渲染任何东西 —— 不编造近似值。

### 计价公式

```
金额 = Σ( 类别 token 数 ÷ 每单位 tokens × 该类别的生效单价 )
类别 = 未缓存输入 / 缓存命中 / 缓存写入 / 输出
```

### 生效单价的优先级

按**回合结束时间**判定（时区用设置里的「时区偏移」，默认 +8 北京时间）：

| 优先级 | 机制 | 说明 |
| --- | --- | --- |
| ① 最高 | **限时特价** `promos` | 绝对时间区间。区间内自成一套价格：`基础价 × 系数`，再用各项「覆盖价」单独替换。**不叠加峰谷系数**。 |
| ② | **峰谷规则** `rules` | 一周内的循环时段（可选星期 + 起止时刻），价格 `× 系数`。支持跨零点（`end < start`）。 |
| ③ | **基础价** | 上面都没有命中时使用。 |

同类规则多条命中时，**列表靠后的优先**（便于后来追加例外）。

### DeepSeek 官方口径怎么填

DeepSeek 的价格政策是「空闲时段价 = 高峰时段价的一半；高峰时段为北京时间周一至周五 09:00–12:00、14:00–18:00」。
所以本插件推荐的填法是：

- **基础价 = 空闲时段价**（平时就是原价，直觉一致）
- **峰谷规则填 ×2**，两条：`周一~周五 09:00–12:00`、`周一~周五 14:00–18:00`

插件默认已按此预填 `deepseek-flash` 与 `deepseek-v4-pro`，设置页里也有「恢复 DeepSeek 官方价」按钮。

> 法定节假日整天都是空闲时段，无法用「星期几」表达；用**限时特价**把该日期区间的系数设为 1
> （或直接写覆盖价）即可单独处理。

## 设置项

设置路径：**设置 → 每轮花费**。

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 显示每轮花费 | 开 | 总开关，关闭后不渲染任何金额 |
| 货币符号 | `¥` | 仅用于显示 |
| 小数位 | `4` | 金额显示的小数位数 |
| 时区偏移 | `+8` | 判定峰谷/特价用的时区（小时） |
| 每多少 tokens | `1000000` | 单价分母，与官方口径一致 |
| 未配置的模型 | `不显示金额` | 或「用兜底价计算」；默认不显示以免误导 |
| 兜底价 | 全 0 | 选择兜底时使用的四个单价 |
| 模型价格 | 见上 | 每个模型：模型 id / 提供方 / 显示名 / 四个基础单价 / 峰谷规则 / 限时特价 |

**提供方留空 = 不限提供方**：同一个模型在多个 provider 下价格相同时只写一条即可；
若某个 provider 价格不同，再单独加一条并填上 provider（精确匹配优先）。

## 存储位置

价格表存在**插件自己的 Cordis Config** 里，由 dsh 的设置框架落盘到：

```
<DSH_HOME>/profiles/<profile>/cordis.patch.yml     # 条目 id: turn-cost
```

跨窗口、跨会话、重启都不丢。若设置服务不可用（例如远端页面），插件自动退回浏览器
`localStorage`，并在设置页给出提示。

## 兼容性与边界

- **dsh 版本**：需要 `>=0.2.0-rc.1 <0.3.0`（`0.2` 的设置模型与 `conversation.chat.turnTail` 槽位）。
  安装器会读 `peerDependencies` 里的 `@deepseek-ai/dsh-client-ui-settings` 做版本闸门；
  不兼容时 `dsh plugin add` 会拒绝，可用 `dsh plugin allow-version` 按精确版本放行。
- **多模型回合**：若一个回合内换了模型（重试等），token 用量无法按模型拆分；插件按
  **最后一次尝试的路由**计价，并在明细里标注「本轮共 N 个路由」。
- **跨时段回合**：按回合**结束时间**判定价格。
- **内置用量徽章被关掉时**：设置 → 通用里把「性能用量」设为 `compact` 会隐藏内置徽章，
  但本插件的金额**不受影响**，始终显示。
- **不做估算**：用量不可证的回合不显示金额，而不是给一个近似值。
- **配色跟随主题**：所有颜色只取 dsh 的 `--dsw-alias-*` 语义变量，且**不写兜底值**。
  不写兜底值是有意的 —— 万一某个变量在你的主题里不存在，底色的退化结果是「透明」、
  文字色的退化结果是「继承」，仍然可读；而写死浅色兜底会让深色模式下变成「浅字浅底」而糊掉。
  深色下的原生控件（复选框、数字输入框）由插件自己按 `body[data-ds-dark-theme]` 声明
  `color-scheme`，因为 dsh 主题包不设这个属性。
  第三方主题只要实现了 dsh 文档化的 14 个核心语义变量，本插件就正常显示。

## 隐私与权限

- 用量取自浏览器侧已有的回合数据，单价取自插件自己的设置；**两者都只在本机**，插件不发任何网络请求。
- 不读取、不复制、不记录任何 API Key 或凭据。
- 不写文件、不执行命令、不注册任何面向模型的工具或提示词（宿主半体只声明一份配置 schema）。

## 目录结构

```
dsh-turn-price/
├── package.json          # dsh.bundle.patch / dsh.client / engines / peerDependencies
├── cordis.patch.yml      # bundle 层：插入 id=turn-cost 的插件条目（id 即设置命名空间）
├── locale/{en,zh}.json   # 插件市场里显示的标题与描述（meta.title / meta.description）
├── icon.svg              # 插件卡片图标
├── screenshots.json      # 市场详情页截图清单（仓库级约定，不进 npm 包）
├── assets/               # 上面那两张截图
└── lib/
    ├── index.js          # 宿主半体：只声明 Config（价格表 schema，根级 .volatile()）
    └── client.js         # 客户端半体：金额行 + 设置页 + 价格引擎
```

## 开发

本仓库**没有依赖也没有构建步骤**，改完 `lib/` 直接在本地 profile 里重启生效。
语法自检：

```bash
npm run check          # node --check lib/index.js && node --check lib/client.js
```

开发用的离线测试（141 项断言：价格引擎 / 配置 schema / 设置表单 / 主题变量纪律）在开发仓库里，
不随包发布，见 [PUBLISHING.md](./PUBLISHING.md)。

## License

[MIT](./LICENSE)
