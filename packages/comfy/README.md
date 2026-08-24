# comfy/ — ComfyUI capability family

English | [中文](README.zh.md)

Drives a [ComfyUI](https://comfy.org) generation server: the service speaks the [Comfy API v2](https://docs.comfy.org/api-reference/v2/overview) (jobs and assets, served by [comfy-api-proxy](https://github.com/Comfy-Org/comfy-api-proxy) in front of a self-hosted ComfyUI, or by Comfy Cloud unchanged) plus the ComfyUI server's model and node discovery; the tools render that capability to the model.

| Package | ctx key | Role |
|---|---|---|
| [`comfy/`](comfy/README.md) (`@deepseek-ai/dsh-comfy`) | `ctx.comfy` | One HTTP client for job lifecycle, asset uploads, and discovery, with deadlines and the `ComfyError` taxonomy |
| [`tool-comfy/`](tool-comfy/README.md) (`@deepseek-ai/dsh-tool-comfy`) | registers on `ctx.tools` | The `comfy_*` tools: submit, poll/wait, cancel, list models, node schema, upload asset |

The [ComfyUI capability decision](../../.agents/notes/implemented/feature/2026-08-24-comfy-capability.md) records the endpoint split and why the family is one client package rather than a provider registry.
