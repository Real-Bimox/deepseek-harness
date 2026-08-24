# Agent Note: 以单一 API-v2 客户端加工具套件构成 ComfyUI 能力

Status: implemented

[English](2026-08-24-comfy-capability.md) | 中文

## Problem

Harness 此前无法驱动 [ComfyUI](https://comfy.org) 生成服务器，因此图像/视频/音频生成工作无法委托给 agent：没有工作流图提交，无法观察运行，也没有发现有效图所需的模型与节点模式的途径。任何集成首先必须回答"ComfyUI 的 API 到底是什么"——对自托管部署而言答案不止一台服务器：ComfyUI 进程本身提供长期稳定的 prompt/queue/models 端点，而带版本、轮询优先的 [Comfy API v2](https://docs.comfy.org/api-reference/v2/overview) 契约（作业、资产、幂等提交）由其前面的另一个进程提供——自托管的 [comfy-api-proxy](https://github.com/Comfy-Org/comfy-api-proxy)，或不变的 Comfy Cloud / Serverless。v2 面刻意不覆盖模型与节点发现。

## Decision

该能力是 `packages/comfy/` 下的两个包：

- `@deepseek-ai/dsh-comfy`（`ctx.comfy`）——单一 HTTP 客户端 `ComfyRuntime`，从配置获得两个默认必填端点：`baseUrl`（任意 Comfy API v2 端点）承载 `submitWorkflow` / `getJob` / `cancelJob` / `waitForJob` / `uploadAsset`；`serverUrl`（ComfyUI 服务器）承载 `listModelFolders` / `listModelFiles` / `getNodeInfo`。线上响应在边界处解析为 camelCase 的 `ComfyJob` / `ComfyAsset`；失败归一化到 `ComfyError` 分类法（`COMFY_REQUEST_FAILED`、`COMFY_TIMEOUT`、`COMFY_ABORTED`、`COMFY_API_ERROR`、`COMFY_NOT_FOUND`、`COMFY_INVALID_RESPONSE`）。`waitForJob` 在一个等待预算内按配置间隔轮询，自身中止时绝不取消服务端工作——`cancelJob` 是工作停止的唯一途径。
- `@deepseek-ai/dsh-tool-comfy`——六个面向模型的工具（`comfy_submit_workflow`、可阻塞等待的 `comfy_get_job`、`comfy_cancel_job`、`comfy_list_models`、`comfy_get_node`、`comfy_upload_asset`），带部署方拥有的超时预算与结果上限、一个无条件系统提示指引小节与通用呈现卡片。工作流原样透传；端点对其进行权威校验，其逐节点拒绝细节经 `COMFY_API_ERROR` 消息与作业 `error` 对象浮现。

端点拆分理由：任一端点都无法提供另一端点的数据（v2 API 没有模型或节点目录；ComfyUI 服务器没有持久作业或资产记录），因此拆分由契约驱动，不是可用性回退。两个基础 URL 都是显式配置，其 loopback 默认值匹配本地代理部署。

## Alternatives considered

- **像 web seam 那样的提供方注册表**（Service Definition + 注册的提供方 + 消费方）落选，因为恰好只有一种传输：v2 契约在代理、Cloud 与 Serverless 之间完全一致，切换 `baseUrl` 即可覆盖所有已知部署。单元素注册表是无主的泛化；若未来出现第二种传输，届时再拆分（预发布姿态）。
- **第一方 `comfy-mcp` 服务器**（stdio MCP，经 `dsh-mcp-client` 驱动）落选于部署拓扑的适配性：它面向本地工作空间包装 `comfy-cli`，其工具只有封闭子集经 `COMFYUI_URL` 远程化，且发现/校验工具会作用于容器化 ComfyUI 旁并不存在的工作空间。MCP 路线适合没有原生集成的客户端；Harness 有。若 `comfy-mcp` 出现 base-URL 传输，可重新评估。
- **直接驱动 ComfyUI 服务器的旧端点**（`/prompt`、`/queue`、`/history`、websocket）落选于 v2 契约的持久性、幂等提交、带 `core/ASSET` 图引用的内容寻址资产与"仅增量变更"的版本化承诺；旧面也没有认证路径，而 v2 携带可选 Bearer 令牌。

## Consequences

Agent 获得端到端生成能力：发现模型与节点模式、提交图、阻塞或轮询结果、取消、以及把本地文件作为资产输入。代价是双端点部署要求：自托管用户必须运行 comfy-api-proxy（或将 `baseUrl` 指向 Comfy Cloud），发现还需要单独可达的 ComfyUI 服务器。该能力信任端点的作业校验而非在客户端重复图检查，因此无效图花费一次被拒绝的请求——其结构化逐节点错误就是反馈回路。包 README 记录了已知缺口：代理报告的输出大小当前为零、资产没有字节下载操作、`comfy_get_job` 以前台等待而非经 `ctx.jobs` 运行时。
