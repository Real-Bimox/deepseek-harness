# 用 ComfyUI 生成

[English](comfyui.md) | 中文

ComfyUI 能力让 agent 在 [ComfyUI](https://comfy.org) 服务器上运行图像、视频与音频生成工作流：发现已安装的模型与节点模式、提交 API 格式工作流图、等待作业并返回输出 URL。本指南覆盖服务端前置条件、组合 overlay、面向模型的工具，以及一次典型生成任务的流程。

## 前置条件：一个 Comfy API v2 端点

带版本的 [Comfy API v2](https://docs.comfy.org/api-reference/v2/overview)（作业与资产）并不由 ComfyUI 进程本身提供。自托管部署在 ComfyUI 前面运行 [comfy-api-proxy](https://github.com/Comfy-Org/comfy-api-proxy)：

```sh
pip install comfy-api-proxy
comfy-api-proxy run --host 127.0.0.1 --port 8189 --comfyui http://127.0.0.1:8188
```

ComfyUI 在 `8188` 提供模型与节点发现端点；代理在 `8189` 提供 `/api/v2/*` 并持有持久作业状态（传入 `--state-dir` 以跨重启持久化）。Comfy Cloud 或 Serverless 端点无需代理——客户端契约完全一致，只是 `token` 里带 Bearer 令牌。

撰写本指南的机器上，示例部署以容器形式在共享网络上运行两者，并将 ComfyUI 的模型库与输出目录从宿主 bind-mount 进容器。

## 把能力组合进 profile

该能力是两个插件：`dsh-comfy` 注册 `ctx.comfy`；`dsh-tool-comfy` 暴露工具。把它们加入任意组合：

```yaml
- id: comfy
  name: '@deepseek-ai/dsh-comfy'
  config:
    baseUrl: http://127.0.0.1:8189
    serverUrl: http://127.0.0.1:8188
- id: tool-comfy
  name: '@deepseek-ai/dsh-tool-comfy'
```

对 headless profile，[`examples/headless-agent/comfy.cordis.yml`](../../../examples/headless-agent/comfy.cordis.yml) 是现成的 overlay：

```sh
pnpm dsh --profile headless --patch examples/headless-agent/comfy.cordis.yml "<task>"
```

`baseUrl` 接受任意 Comfy API v2 端点；`serverUrl` 指向 ComfyUI 服务器本身，支撑模型与节点发现。二者都默认为上述 loopback 端口；当端点需要认证时，`token` 读取 `COMFY_API_TOKEN`。

## 工具

| 工具 | 用途 |
|---|---|
| `comfy_list_models` | 模型目录（无参数）或单目录内的文件 |
| `comfy_get_node` | 单个节点类的输入模式：名称、类型、默认值、允许值 |
| `comfy_submit_workflow` | 提交 API 格式图；返回 `{ jobId, status }` |
| `comfy_get_job` | 状态、进度、输出、错误；`wait: true` 阻塞到终态 |
| `comfy_cancel_job` | 请求取消；幂等 |
| `comfy_upload_asset` | 上传本地文件并在图中以资产 id 引用 |

工作流是 API 格式——节点 id 到 `{"class_type": string, "inputs": object}` 的映射。UI 格式导出（带 `nodes`/`links` 的形状）会被服务端拒绝。输入以 `["<源节点 id>", <输出槽>]` 连接。

## 一次生成的分步流程

用自然语言说出想要什么；下面的步骤就是 agent 会做的事。

1. **发现**。`comfy_list_models` 带 `folder: "diffusion_models"` 找到已安装的生成器；`comfy_get_node` 带 `classType: "KSampler"`（或任何将要使用的节点）返回其确切输入——服务器接受哪些模型槽名、采样器与取值范围。
2. **构建图**。先加载器（UNET/CLIP/VAE），再条件化、采样器、解码，最后 `SaveImage` 节点，让输出既落在服务器输出目录，也作为作业资产。
3. **提交并等待**。`comfy_submit_workflow`，随后 `comfy_get_job` 带返回的 `jobId` 与 `wait: true`。作业经历 `queued → running → succeeded`；进度随轮询状态到达，输出携带在作业保留期限前有效的下载 URL。
4. **读取结果**。成功的作业把输出列为 `- <type> <name> → <url>`；同样的文件也落在服务器输出目录。失败的作业报告出错节点、类与回溯摘录。

要使用本地文件（例如配合编辑模型的输入图），先用 `comfy_upload_asset` 上传，并在图中通常写文件名的位置放返回的资产 id：`{"__type": "core/ASSET", "info": {"id": "<asset id>"}}`。

## 失败与限制

提交是同步校验的：无效图在任何工作开始前即被逐节点细节拒绝，并以 `COMFY_API_ERROR` 消息浮现。超过部署 `getTimeoutMs` 预算（默认 10 分钟）的运行使*调用*失败，而不是作业——用 `comfy_get_job` 再查，或用 `comfy_cancel_job` 取消；取消在节点与步边界生效。模型文件必须与服务器上的其他租户共同装进 VRAM；共享 GPU 上的生成工作负载需要余量。

[包 README](../../../packages/comfy/README.zh.md) 拥有配置面、错误分类法与已知限制。
