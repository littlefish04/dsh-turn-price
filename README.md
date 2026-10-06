# dsh-turn-price

[![npm version](https://img.shields.io/npm/v/dsh-turn-price.svg)](https://www.npmjs.com/package/dsh-turn-price)
[![license MIT](https://img.shields.io/npm/l/dsh-turn-price.svg)](./LICENSE)
[![dsh-plugin topic](https://img.shields.io/badge/topic-dsh--plugin-2ea44f)](https://github.com/topics/dsh-plugin)
[![DSH](https://img.shields.io/badge/dsh-%3E%3D0.2.0--rc.1%20%3C0.3.0-4176e6)](https://github.com/deepseek-ai/deepseek-harness)

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 Web 界面里，**在每个已完成回合的下方单独一行显示这一轮花了多少钱**，点击可展开明细（各 token 类别的数量 × 单价 = 金额、命中的价格规则、计费时刻）。

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) web plugin that shows **what each turn cost, in CNY**, on its own row under the turn. Click the amount for a breakdown: tokens per category × unit rate = money, which price rule matched, and the billing instant.

金额按当前价格表**实时计算**：token 用量取自 dsh 会话日志里每个步骤的 `usage`，插件不做字符数估算，所以你事后修改价格，**所有历史回合的金额会立刻跟着更正** —— 这正是「忘了提前改价」的补救方式。

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
| 模型 | `模型：<provider> / <model>`；一个回合换过模型时附注 `（本轮经过 N 个路由，按路由表中的最后一个计价）` |
| 计费时刻 | `计费时刻：2026-10-03 19:16（UTC+8，星期六）` |
| token 来源 | `token 来源：宿主折叠的会话事件，按每步 usage 容错求和（N 个样本）`；宿主不可用时写明「本页会话数据」 |
| 生效价格 | `生效价格：基础价（DeepSeek Flash）`，或 `高峰 ×2` / `限时优惠 ×1` |
| 单价口径 | `单价口径：每 1,000,000 tokens` |
| 明细表 | `类别 / tokens / 单价 / 金额` 四列，之下是 `合计` 行 |

设置 → **每轮花费**：按模型分页签维护价格表，改完保存，**所有历史回合的金额立即重算**。

![设置页：每轮花费](https://cdn.jsdelivr.net/gh/littlefish04/dsh-turn-price@main/assets/shot-settings.png)

## 它是怎么算的

### token 用量来源

**按每个步骤的 `usage` 容错求和**，而不是直接用 dsh 内置的严格折叠：

```
宿主（lib/session-usage.js）折会话事件 → 每轮 { buckets, routes, endSeq, endTime, reason }
  桶 = { inputTokens, outputTokens, cacheReadTokens ?? 0, cacheWriteTokens ?? 0 }
```

为什么要换掉严格折叠（`deriveTurnTokenUsage`）：它要求「有 `totalTokens`，或 `cacheRead` + `cacheWrite` 都有」，
否则**整轮判为不可证**、一个字都不显示。实测（本机 24 份真实会话日志 / 79 个回合）有 **15 个回合**因此
连金额都出不来 —— 它们的共同形状是 `{inputTokens, outputTokens, cacheReadTokens}`
（`zai/glm-5.3-flash`、`deepseek-vision/deepseek-v4-flash` 都这样：**有缓存命中、缺缓存写入、缺 total**）。
被手动停止的回合也一样会整轮消失。

容错求和的口径（与 dsh 的 `tokenUsage` 投影**逐项相等**，测试里拿官方定义对拍过）：

- 缺 `cacheReadTokens` / `cacheWriteTokens` → 记 0；
- 缺 `usage` 的步骤（中途被停止的那一步）→ 跳过，其余步骤照常计；
- `totalTokens` / `reasoningTokens` **不参与**计价；
- 同一步的后续样本**替换**前一个；`llm/retry-started` 之后的样本**累加**（重试的两次尝试都算钱）；
- 整轮一个样本都没有 → **不显示金额**（而不是显示 `¥0.0000`）。

浏览器侧还有一条**回退路径**：宿主不可用时按页面上每步的 `assistant-step.usage` 同样容错求和。
回退路径拿不到路由时会借用严格折叠留下的 `routes`，明细里会注明数据来源。

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

设置路径：**设置 → 每轮花费**，同一节内 4 张卡片：**模型价格 → 账户与余额 → 消费记录 → 显示项**。
逐项说明见下面的〈设置页的 4 张卡片〉一节；这里只列最常用的几个数：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 显示每轮花费与汇总行 | 开 | 总开关，关闭后不渲染任何金额 |
| 货币符号 | `¥` | 估算金额用它（余额段用余额接口返回的币种） |
| 明细小数位 | `4` | 轮尾明细的位数 |
| 汇总行小数位 | `2` | 输入框下方汇总行的位数 |
| 时区偏移 | `+8` | 判定峰谷/特价、以及日账归属哪一天都用它 |
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
  **该回合路由表中的最后一个**计价，并在明细里标注「本轮经过 N 个路由」。
  > 措辞说明：dsh 的折叠用 `Map` 去重路由，重复写入**不改变先后位置**，所以「最后一个」
  > 指的是最后一个**不同的**路由，不保证是"最后一次尝试"。这是既有行为，插件与之保持一致。
- **跨时段回合**：按回合**结束时间**判定价格。
- **内置用量徽章被关掉时**：设置 → 通用里把「性能用量」设为 `compact` 会隐藏内置徽章，
  但本插件的金额**不受影响**，始终显示。
- **不做字符数估算**：没有任何 `usage` 样本的回合不显示金额，而不是给一个近似值。
- **配色跟随主题**：所有颜色只取 dsh 的 `--dsw-alias-*` 语义变量，且**不写兜底值**。
  不写兜底值是有意的 —— 万一某个变量在你的主题里不存在，底色的退化结果是「透明」、
  文字色的退化结果是「继承」，仍然可读；而写死浅色兜底会让深色模式下变成「浅字浅底」而糊掉。
  深色下的原生控件（复选框、数字输入框）由插件自己按 `body[data-ds-dark-theme]` 声明
  `color-scheme`，因为 dsh 主题包不设这个属性。
  第三方主题只要实现了 dsh 文档化的 14 个核心语义变量，本插件就正常显示。

## 隐私与权限

- 每轮金额所需的 token 用量与单价**都在本机**：用量由宿主半体折会话日志得到，
  界面通过**与 dsh 同源**的 `/dsh-turn-price/*` 读取，不发往任何第三方。
- 不读取、不复制、不记录任何 API Key 或凭据（宿主半体不含凭据相关代码）。
- 不写文件、不执行命令、不注册任何面向模型的工具或提示词。
- 宿主半体只读取**当前会话自己的**事件流以统计每轮用量；不扫描其它会话的正文。

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
    ├── index.js           # 宿主半体：Config + 折叠装配 + /dsh-turn-price/* 路由
    ├── session-usage.js   # 每轮 token 的容错折叠（与官方 tokenUsage 投影语义一致）
    ├── child-usage.js     # 子代理会话枚举与用量投影（深度/数量/超时上限）
    ├── ledger.js          # 真实日账（余额观测差值法）+ 估算账 + 保留期 + 原子写/损坏恢复
    ├── balance.js         # 12 个余额/额度适配器（解析纯函数 + 取数 + 错误分类）
    ├── balance-runtime.js # 余额管理器：凭据 → 指纹分本 → 取数 → 观测入账 → 定时刷新
    ├── http.js            # 宿主侧 JSON-over-HTTP 小工具
    └── client.js          # 客户端半体：金额行 + 汇总行 + 设置页 4 卡片 + 价格引擎（唯一计价实现）
```

宿主与浏览器半体之间的协议（响应一律 JSON、都带 `ok`）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/dsh-turn-price/usage.json?sessionId=<id>` | 该会话每轮 `{ endSeq, endTime, route, routes, buckets }` + 会话合计 + **子代理** + 折叠自查 |
| GET | `/dsh-turn-price/state.json?sessionId=<id>` | 余额 / 额度、本月、今日（真实）、今日与本月估算轮次、账本元信息 |
| POST | `/dsh-turn-price/refresh?what=balance` | 立刻刷新余额，返回新的 state |
| POST | `/dsh-turn-price/test-connection` | 用**草稿参数**测一次连接，**不保存**（密钥不回显） |
| POST | `/dsh-turn-price/credentials` | 凭据管理：`describe` / `set` / `unset`（**永不回显密钥值**） |
| POST | `/dsh-turn-price/correction` | 手工校正某一天的消费额（充值后把真实消费修回来） |
| GET | `/dsh-turn-price/ledger`（`?export=1`） | 读账本 / 导出日账 JSON |
| POST | `/dsh-turn-price/ledger/clear` | 清空估算账（`what=estimates`）或全部记录（`what=all`） |
| GET | `/dsh-turn-price/ping.json` | 探活（宿主是否已带路由启动） |

## 设置页的 4 张卡片

设置路径：**设置 → 每轮花费**，同一节内 4 张卡片，顺序固定（模型价格在最上方）。

### 卡片 1：模型价格（最上方）

按模型分页签维护价格表：模型 id / 提供方 / 显示名 / 四个基础单价 / 峰谷规则 / 限时特价，
以及「恢复 DeepSeek 官方价」按钮。

### 卡片 2：账户与余额

余额来源列表（可增删），每行：启用开关、名称、适配器（12 个内置适配器 + `none`）、
匹配的 provider id（逗号分隔）、凭据名、Base URL，以及**测试连接**与**替换密钥**两个动作。

- **API key 只写不读回**：存在 DSH 的凭据库里（`ctx.credentials`），不写进配置文件、不进账本、
  不出现在任何接口响应里；界面只显示「已配置 · 来源」。
- **测试连接**用草稿参数，不保存配置；失败会给出分类（无 key / 401 / 403 / 网络 / 超时 / 结构变化 / 无余额接口）。
- `none` 适配器表示**该 provider 没有「用 API key 查余额」的接口**（火山方舟、OpenAI、Anthropic、
  Gemini、xAI…），界面显示 `—` 并只做探活 —— 不猜一个数字出来。
- 额度型（智谱 / z.ai / Kimi Coding / MiniMax）显示**剩余百分比与重置时间**，并标明这不是钱。
- 刷新间隔默认 300 秒（60–3600），超时默认 8000 毫秒。

### 卡片 3：消费记录

- 保留时长（1–24 个月，默认 12）+ 当前账本体积 + **下一条将被裁剪的日期**；
- 每月起始日（1–31，按当月天数自动钳制：填 31 时 2 月按 28/29、4 月按 30），改完保存立即重算；
- 观测状态：当前账本、保留期内的最早日期、今天是否观测中、今日真实消费；
- **导出日账 JSON** / **清空估算账** / **清空全部记录**（后两个要先输入确认文字）。

### 卡片 4：显示项

5 段的显示开关 + 上/下移动调整顺序、汇总行小数位（0–4，默认 2）、
是否显示「更新于 x 分钟前」、估算徽标与「数据不完整」徽标文案，以及一个**用示例数字的预览行**。

## 它是怎么记账的

### 真实花费（余额观测差值法）

每次取到余额就记一次观测（默认 300 秒一次）。同一天的观测写成一行：

- 余额**下降** = 消费；余额**上升** = 记 `creditUnits` 并标「待核对」（差额里可能混着充值）；
- 乱序/重复样本（含**晚到的昨日样本**）一律忽略；
- **数据不完整**判定：某天首个观测距 00:00、或该天最后一个观测距 24:00 超过 **10 分钟** → 该天标「数据不完整」；
  **今天**永远算「观测中」，不参与这个判定（app 不会在 00:00 就开着）。
- **手工校正**：填「本区间累计充值额 / 其它支出」，真实消费 = `期初 + 充值 − 其它支出 − 期末`。
- **没有观测的日子留空（`—`）**，与「观测到当天消费 0 元（`¥0.00`）」是两种不同状态。
- 金额一律用整数微单位（×1e8）计算，避免浮点误差；账本用**原子写**（写临时文件再 rename），
  文件损坏时改名备份后重建 —— 绝不会因此让 DSH 起不来。
- **按密钥指纹分本**：换 key 就换一本账，新账户的余额基线不会污染历史。

### 估算是实时增量

只累计**本插件运行期间**发生的轮次，**不回溯扫描历史会话**。日归属用插件的时区偏移
（与轮尾计费时刻同一套逻辑）。「今日估算」是逐轮按**各自的时刻**计价再求和 ——
不能先把 token 桶合并再算一次，否则跨时段的轮次会算错峰谷价。

### 会话总计

**父会话逐轮计价 + 子会话按 `tokenUsage` 投影 × 单价**。子会话那半边天生是近似
（投影只给会话级 4 桶、没有逐轮时刻），所以明细里会**标注每个子代理按哪个模型计价**；
列表被深度（5）/数量（200）/超时（3 秒）上限截断时，行内会挂「部分」标记。

## 开发

本仓库**没有依赖也没有构建步骤**，改完 `lib/` 直接在本地 profile 里重启生效。
语法自检：

```bash
npm run check          # node --check lib/*.js
```

> ⚠️ **本地源码改了不会自动生效**：profile 里那份是从 npm 装的副本，`lib/` 是**真实目录**。
> 新增的 `lib/*.js` 必须同步过去（开发仓库里的 `tools/sync-to-profile.ps1` 会做这件事，
> 并且同步后自动跑发布清单校验）。宿主半体（`lib/index.js`、`lib/session-usage.js`、`lib/http.js`）
> 改动需要**重启 dsh**，只改 `lib/client.js` 刷新页面即可。

开发用的离线测试（价格引擎 / 折叠语义 / 配置 schema / 设置表单 / 主题变量纪律）在开发仓库里，
不随包发布，见 [PUBLISHING.md](./PUBLISHING.md)。

## License

[MIT](./LICENSE)
