# comfy/：ComfyUI 能力家族

[English](README.md) | 中文

驱动 [ComfyUI](https://comfy.org) 生成服务器：服务面向 [Comfy API v2](https://docs.comfy.org/api-reference/v2/overview)（作业与资产，由自托管 ComfyUI 前面的 [comfy-api-proxy](https://github.com/Comfy-Org/comfy-api-proxy) 或不变的 Comfy Cloud 提供）以及 ComfyUI 服务器的模型与节点发现；工具将该能力呈现给模型。

| 包 | ctx key | 角色 |
|---|---|---|
| [`comfy/`](comfy/README.zh.md)（`@deepseek-ai/dsh-comfy`） | `ctx.comfy` | 面向作业生命周期、资产上传与发现的单一 HTTP 客户端，带截止时间与 `ComfyError` 分类法 |
| [`tool-comfy/`](tool-comfy/README.zh.md)（`@deepseek-ai/dsh-tool-comfy`） | 注册于 `ctx.tools` | `comfy_*` 工具：提交、轮询/等待、取消、列出模型、节点模式、上传资产 |

[ComfyUI 能力决策](../../.agents/notes/implemented/feature/2026-08-24-comfy-capability.zh.md)记录了端点拆分，以及该家族为何是单一客户端包而非提供方注册表。
