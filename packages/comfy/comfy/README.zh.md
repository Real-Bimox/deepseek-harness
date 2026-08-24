# dsh-comfy — ComfyUI 能力服务（`ctx.comfy`）

[English](README.md) | 中文

驱动 [ComfyUI](https://comfy.org) 生成服务器的单一 HTTP 客户端：面向 [Comfy API v2](https://docs.comfy.org/api-reference/v2/overview) 端点执行作业生命周期与资产上传，并面向 ComfyUI 服务器本身进行模型与节点发现。`dsh-tool-comfy` 将该能力呈现给模型；本包负责传输、超时与 `ComfyError` 分类法。

## Service API

`ComfyRuntime`（默认导出）注册为 `ctx.comfy`。每个方法都接受可选的 `AbortSignal`，应用已配置的每请求截止时间，失败时抛出 `ComfyError`。

| 方法 | 端点 | 返回 |
|---|---|---|
| `submitWorkflow(workflow, signal?)` | `POST /api/v2/jobs` | 排队中的 `ComfyJob` |
| `getJob(id, signal?)` | `GET /api/v2/jobs/{id}` | 权威的 `ComfyJob` |
| `cancelJob(id, signal?)` | `POST /api/v2/jobs/{id}/cancel` | 取消请求当下的 `ComfyJob` |
| `waitForJob(id, { timeoutMs }, signal?)` | 轮询 `getJob` | 终态 `ComfyJob`，否则 `COMFY_TIMEOUT` / `COMFY_ABORTED` |
| `listModelFolders(signal?)` | `GET {serverUrl}/models` | ComfyUI 服务器提供的目录名 |
| `listModelFiles(folder, signal?)` | `GET {serverUrl}/models/{folder}` | 单个目录内的文件名 |
| `getNodeInfo(classType, signal?)` | `GET {serverUrl}/object_info/{classType}` | 单个节点类的输入模式 |
| `uploadAsset({ bytes, filePath, contentType }, signal?)` | `POST /api/v2/assets` | 铸造出的 `ComfyAsset` |

作业状态：`queued → running → succeeded | failed | expired`；取消请求将 `running` 迁移到 `canceling → canceled`。终态为 `succeeded`、`canceled`、`failed` 与 `expired`。

## Config

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8189` | Comfy API v2 端点（comfy-api-proxy、Comfy Cloud 或 Serverless 部署——同一契约） |
| `serverUrl` | `http://127.0.0.1:8188` | 用于 v2 API 未覆盖的发现端点的 ComfyUI 服务器 |
| `token` | `COMFY_API_TOKEN` | `baseUrl` 的 Bearer 令牌；端点接受匿名请求时省略 |
| `requestTimeoutMs` | `30000` | 每请求截止时间 |
| `pollIntervalMs` | `1000` | `waitForJob` 内部的轮询间隔 |

## 设计说明

- 两个端点源于契约拆分：v2 API 拥有持久作业与资产；ComfyUI 服务器拥有其模型库与节点模式。二者互不可推导，因此都是显式的默认必填配置。
- 线上响应在边界处解析：未知状态、输出类型或缺失的必填字段成为 `COMFY_INVALID_RESPONSE`，不会泄漏残缺的作业对象。
- `submitWorkflow` 每次调用发送新的 `Idempotency-Key`，因此重试会提交新作业；该键只为让代理的一次尝试内拒绝重复语义保持诚实。
- `waitForJob` 返回或抛出而不触碰作业本身；`cancelJob` 是停止工作的唯一途径。被中止的等待是调用方关注点，绝不是服务端取消。

## 错误

`ComfyError` 扩展 `HarnessError`，携带开放字符串 `code`：`COMFY_REQUEST_FAILED`（传输）、`COMFY_TIMEOUT`（请求或等待预算）、`COMFY_ABORTED`（调用方取消）、`COMFY_API_ERROR`（非 2xx；API 错误封套的 code 与 message 随消息携带）、`COMFY_NOT_FOUND`（404）与 `COMFY_INVALID_RESPONSE`（畸形响应体）。

## Model Experience

None, as the HTTP client registers no model context; `dsh-tool-comfy` owns every rendered effect.

#### KV Cache effect

该服务不贡献任何提示词或模式 token，无法使任何可复用前缀失效；只有其消费方的注册会影响模型请求。

## Known Limitations and Deferred Work

- **Output sizes are advisory** — comfy-api-proxy 0.1.x 为作业输出记录 `sizeBytes: 0`；在代理填充该字段之前，消费方应将大小视为不可靠。
- **No asset byte download** — 服务只获取资产元数据；消费方从输出的 `url`（支持 Range）下载字节，或读取服务器的输出目录。
