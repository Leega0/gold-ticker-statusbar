# Gold Ticker Status Bar

一个轻量的 VS Code 插件，在底部状态栏实时显示：

- 国际金价：`伦敦金 / XAU`，单位为美元/盎司
- 中国金价：默认使用京东黄金盯盘页中的 `民生金`
- 可选切换到：`浙商金`、京东 `Au99.99` 快照、`伦敦金 × USD/CNY ÷ 31.1034768` 实时换算，或上海黄金交易所 `Au99.99` 延时行情

默认配色为“涨红跌绿”，并支持在设置里自定义文字颜色、标签和刷新频率。
插件会缓存上一次成功价格，因此就算某次网络请求慢或失败，也不会一启动就完全不可用。

## 功能特性

- 双状态栏项展示，国际金价和中国金价分开着色
- 国际金价默认改为 `京东黄金盯盘页中的伦敦金快照`
- 中国金价默认改为 `京东黄金盯盘页中的民生金`
- 可通过设置切到 `浙商金`
- 仍保留京东 `Au99.99` 快照作为兼容模式
- 仍可切回上海黄金交易所 `Au99.99` 延时行情
- 仍可切回集金号实时行情或人民币金参考换算
- 默认每秒刷新一次金价
- 状态栏红绿与涨跌额优先按源站涨跌显示，更符合行情软件习惯
- 轮询会尽量按 1 秒一次发起；如果单次请求本身耗时较长，下一轮会立即补上
- 点击状态栏可立即手动刷新
- 支持隐藏任意一个状态栏项
- 支持自定义中国金价来源、上金所合约、标签、精度、颜色和状态栏位置

## 可配置项

在 `settings.json` 中可以这样配置：

```json
{
  "goldTicker.refreshIntervalMs": 1000,
  "goldTicker.showInternational": true,
  "goldTicker.showChina": true,
  "goldTicker.statusBarAlignment": "left",
  "goldTicker.internationalLabel": "伦敦金",
  "goldTicker.chinaLabel": "民生金",
  "goldTicker.chinaSource": "jdBank",
  "goldTicker.chinaBank": "minsheng",
  "goldTicker.chinaSymbol": "Au99.99",
  "goldTicker.showDelta": true,
  "goldTicker.usdPrecision": 2,
  "goldTicker.cnyPrecision": 2,
  "goldTicker.deltaPrecision": 2,
  "goldTicker.upColor": "#dc2626",
  "goldTicker.downColor": "#16a34a",
  "goldTicker.flatColor": "",
  "goldTicker.loadingColor": "",
  "goldTicker.errorColor": ""
}
```

## 数据来源

- 国际金价默认：`京东黄金盯盘页快照 (WG-XAUUSD)`
- 中国金价默认：`京东黄金盯盘页银行金价 (民生金 / 浙商金)`
- 中国金价兼容模式：`京东黄金盯盘页快照 (SGE-Au99.99)`
- 中国金价参考换算：`京东或 Sina 的伦敦金 + 汇率`
- 中国金价延时模式：`上海黄金交易所延时行情`
- 备用回退：`集金号实时行情`

说明：

- 国际金价现在优先按“京东黄金盯盘页里的伦敦金”口径显示，JD 快照不可用时会自动回退到旧源。
- 状态栏里的红绿和 `▲/▼` 现在优先跟随源站涨跌；只有上游不提供涨跌时，才回退成相对上一次刷新。
- `chinaSource = "jdBank"` 时，显示的是京东黄金盯盘页里的银行金价，并可用 `goldTicker.chinaBank` 在 `民生金` 和 `浙商金` 间切换。
- `chinaSource = "jdSnapshot"` 时，显示的是京东黄金盯盘页里的 `Au99.99` 快照，作为兼容旧配置保留。
- `chinaSource = "proxy"` 时，显示的是实时人民币金参考价，优点是更新快；缺点是它不是上金所现货盘口。
- `chinaSource = "sgeDelayed"` 时，显示的是上金所延时价，优点是更贴近上金所口径；缺点是天生不是秒级实时。
- `chinaSource = "jijinhao"` 时，显示的是集金号 `Au99.99` 行情。
- 国际源和国内源是否“每秒变价”取决于上游数据源；插件这边能保证尽量按秒轮询，但不能强制源站每秒更新报价。
- 如果你所在网络到行情源延迟较高，插件现在会自动放宽超时并重试一次，优先保证可用性。
