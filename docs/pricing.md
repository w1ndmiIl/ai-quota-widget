# 模型单价维护

核对日期：2026-10-01。单位为美元 / 百万 Token；使用标准文本 API 单价估算，不代表订阅账单。长上下文、加速档、区域、工具和缓存存储附加费不从本地汇总记录推断。

| 模型 | 输入 | 缓存读取 | 缓存写入 | 输出 |
| :--- | ---: | ---: | ---: | ---: |
| GPT-6 Astra | 10 | 1 | 12.5 | 50 |
| GPT-6 Sol | 2 | 0.2 | 2.5 | 10 |
| GPT-6.1 Sol | 2 | 0.1 | 2.5 | 10 |
| GPT-6 Luna | 0.1 | 0.01 | 0.125 | 0.5 |
| Claude Opus 5.5 | 4 | 0.2 | 5 | 20 |
| Claude Sonnet 5.5 | 2 | 0.2 | 2.5 | 10 |
| DeepSeek V4.1 Flash 谷时 | 0.15 | 0.003 | 0.15 | 0.6 |
| DeepSeek V4.1 Flash 峰时 | 0.3 | 0.006 | 0.3 | 1.2 |

GPT-6 Astra 于 9 月 3 日、Sol/Luna 于 9 月 22 日、6.1 Sol 于 9 月 29 日发布。Claude Opus 5.5 于 9 月 22 日、Sonnet 5.5 于 9 月 28 日发布。更早的历史记录不会套用这些新模型单价。[OpenAI 定价](https://developers.openai.com/api/docs/pricing)、[OpenAI 更新日志](https://developers.openai.com/api/docs/changelog)、[Claude 定价](https://platform.claude.com/docs/en/about-claude/pricing)、[Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview)、[Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)。

DeepSeek 的 `deepseek-flash` 为 V4.1 Flash；旧 `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp` 自 2026-09-10 04:00 UTC 起按新 Flash 单价处理，此前保留旧价格。V4 Pro 保留其自身计价。峰时为工作日 UTC 01:00–04:00、06:00–10:00，中国公共假期除外；当前内置 2026 年日历。缺少时间戳时使用峰时价。[当前价目表](https://api-docs.deepseek.com/quick_start/pricing/?helper=penn&method=individual)、[价格生效公告](https://api-docs.deepseek.com/news/news260910/)、[2026 年放假通知](https://www.beijing.gov.cn/cs/gncs/zcwj/202603/t20260327_4568275.html)。

Gemini 3.6/3.7/3.8 Flash 在 2026 年底前仍为输入 0.75、缓存读取 0.075、输出 3.75；2027-01-01 起分别为 1.5、0.15、7.5。旧 Token 保留记录时单价。音频/图片生成型号无法从文本汇总准确估价，保持未定价。[Gemini 官方价目表](https://ai.google.dev/gemini-api/docs/pricing)。

模型名称支持常见供应商前缀和已核实的版本形式；新小版本优先独立匹配，防止 Opus 5.5 被当作 Opus 5。新增模型必须同时核对输入、缓存、输出、发布日期及价格生效时间，并更新价格回归用例。
