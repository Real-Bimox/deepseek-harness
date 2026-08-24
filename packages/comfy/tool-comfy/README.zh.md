# dsh-tool-comfy — 面向模型的 ComfyUI 工具

[English](README.md) | 中文

将 `ctx.comfy` 以六个工具呈现给模型：工作流提交、作业轮询（可阻塞）、取消、模型发现、节点模式查询与输入资产上传。本包负责模式、提示词指引、限额与呈现；`dsh-comfy` 负责传输。

## Tools

| 工具 | 用途 | 并发 |
|---|---|---|
| `comfy_submit_workflow` | 提交 API 格式工作流图；返回 `{ jobId, status }` | 独占 |
| `comfy_get_job` | 作业状态、进度、输出、错误；`wait: true` 阻塞到终态 | 并发 |
| `comfy_cancel_job` | 请求取消；幂等 | 独占 |
| `comfy_list_models` | 模型目录（无参数）或单目录内文件 | 并发 |
| `comfy_get_node` | 单个节点类的输入模式 | 并发 |
| `comfy_upload_asset` | 上传本地文件；返回 `core/ASSET` 引用 id | 独占 |

工作流是 API 格式图（节点 id 到 `{"class_type": string, "inputs": object}` 的映射）；UI 格式导出会被服务端拒绝。输入文件通过上传进入图，并以返回的资产 id 作为 `{"__type": "core/ASSET", "info": {"id": "<asset id>"}}` 引用。

## Config

| 字段 | 默认值 | 含义 |
|---|---|---|
| `submitTimeoutMs` | `30000` | `comfy_submit_workflow` 的协作预算 |
| `getTimeoutMs` | `600000` | `comfy_get_job`（含阻塞等待）的协作预算 |
| `cancelTimeoutMs` | `30000` | `comfy_cancel_job` 的协作预算 |
| `listTimeoutMs` | `30000` | `comfy_list_models` 的协作预算 |
| `nodeTimeoutMs` | `30000` | `comfy_get_node` 的协作预算 |
| `uploadTimeoutMs` | `120000` | `comfy_upload_asset` 的协作预算 |
| `listMaxEntries` | `200` | 单次列出的模型名数量上限 |
| `nodeMaxOutputChars` | `20000` | 单个节点模式的呈现字符上限 |
| `uploadMaxBytes` | `104857600` | 可接受的最大上传（代理默认 100 MB） |

超时以 `ToolDefinition.timeoutMs` 附着，由 `@deepseek-ai/dsh-tool-call-timeout-policy` 强制执行；它们是部署策略，绝不是模型参数。

## Model Experience

### System prompt

#### What the model sees

ComfyUI 能力注册一个指引小节。

##### ComfyUI capability guidance

```markdown
Use the ComfyUI tools to run image, video, and audio generation workflows on the configured ComfyUI server. Build workflows in API format: a map of node id to {"class_type": string, "inputs": object}. Discover model files with comfy_list_models and node input schemas with comfy_get_node. Submit with comfy_submit_workflow, then call comfy_get_job with wait=true to block until the job finishes and get output URLs. Cancel unwanted jobs with comfy_cancel_job. To feed a local file (for example an input image) into a workflow, upload it with comfy_upload_asset and reference the returned asset id in the graph as {"__type": "core/ASSET", "info": {"id": "<asset id>"}}.
```

#### Token effect

插件加载期间每次请求有固定指引成本；该小节无条件注册，没有任何配置会改变其文本。

#### KV Cache effect

插件加载期间前缀稳定；插件生命周期可能从首个变化的提示词小节起使复用失效。

### Tool schemas

#### What the model sees

模型看到生成的 [`comfy_*` 模式](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-comfy)。预算与上限是部署设置，不是模型参数。

#### Token effect

六个工具每次请求有固定模式成本；没有按工具的启停开关，集合只随插件生命周期变化。

#### KV Cache effect

定义与可见性不变时前缀稳定；插件生命周期或作用域内的模式限制可能从首个变化的模式 token 起使复用失效。

### Tool results

#### What the model sees

数据依赖的作业状态：状态行、可选的队列位置与进度行（`NN%`，可带 ` step s/t (NodeClass)`）、形如 `- <type> <name> → <url>` 的输出行，以及失败时的 `error[ at node <id> (<class>)]: <code>: <message>` 行与 1500 字符的回溯摘录。列出结果携带范围、名称，被上限截断时带截断说明。上传结果携带资产 id 与逐字的 `core/ASSET` 引用形式。

#### Token effect

数据依赖的结果在压缩前持续重发；列出受 `listMaxEntries` 限制，呈现的模式文本受 `nodeMaxOutputChars` 限制，回溯受固定摘录长度限制。

#### KV Cache effect

Append-only；新出现的内容跟随可复用请求前缀，不会使既有 KV-cache 条目失效。

## Known Limitations and Deferred Work

- **No background jobs** — `wait: true` 的 `comfy_get_job` 在前台调用内阻塞；超过 `getTimeoutMs` 的运行会使调用失败，而作业继续在服务端运行。`ctx.jobs` 运行时是真正的后台等待的延后归宿。
- **Uploads read the harness host only** — `comfy_upload_asset` 只在本地文件系统解析 `path`；沙箱或远程执行世界必须先把文件暂存到宿主。
