# Agent Note: the ComfyUI capability as one API-v2 client plus tool suite

Status: implemented

English | [中文](2026-08-24-comfy-capability.zh.md)

## Problem

The harness had no way to drive [ComfyUI](https://comfy.org) generation servers, so image/video/audio generation work could not be delegated to an agent: no submission of workflow graphs, no way to observe a run, no discovery of the models and node schemas a valid graph needs. Any integration first had to decide what "the ComfyUI API" even is for a self-hosted deployment, because the answer is not one server: the ComfyUI process itself serves the long-stable prompt/queue/models endpoints, while the versioned, poll-first [Comfy API v2](https://docs.comfy.org/api-reference/v2/overview) contract (jobs, assets, idempotent submission) is served in front of it by a separate process — [comfy-api-proxy](https://github.com/Comfy-Org/comfy-api-proxy) self-hosted, or Comfy Cloud / serverless unchanged. The v2 surface deliberately does not cover model or node discovery.

## Decision

The capability is two packages under `packages/comfy/`:

- `@deepseek-ai/dsh-comfy` (`ctx.comfy`) — one HTTP client `ComfyRuntime` with two required-by-default endpoints from config: `baseUrl` (any Comfy API v2 endpoint) for `submitWorkflow` / `getJob` / `cancelJob` / `waitForJob` / `uploadAsset`, and `serverUrl` (the ComfyUI server) for `listModelFolders` / `listModelFiles` / `getNodeInfo`. Wire responses are parsed at the boundary into camelCase `ComfyJob` / `ComfyAsset` values; failures normalize to a `ComfyError` taxonomy (`COMFY_REQUEST_FAILED`, `COMFY_TIMEOUT`, `COMFY_ABORTED`, `COMFY_API_ERROR`, `COMFY_NOT_FOUND`, `COMFY_INVALID_RESPONSE`). `waitForJob` polls with the configured interval under one wait budget and never cancels server-side work on its own abort — `cancelJob` is the only way work stops.
- `@deepseek-ai/dsh-tool-comfy` — six model-facing tools (`comfy_submit_workflow`, `comfy_get_job` with an optional blocking `wait`, `comfy_cancel_job`, `comfy_list_models`, `comfy_get_node`, `comfy_upload_asset`) with deployment-owned timeout budgets and result caps, one unconditional system-prompt guidance section, and generic presentation cards. Workflows pass through verbatim; the endpoint validates them authoritatively and its per-node rejection detail surfaces through `COMFY_API_ERROR` messages and job `error` objects.

Endpoint split rationale: neither endpoint can serve the other's data (the v2 API has no model or node catalog; the ComfyUI server has no durable job or asset records), so the split is contract-driven, not an availability fallback. Both base URLs are explicit config with loopback defaults matching a local proxy deployment.

## Alternatives considered

- **A provider registry like the web seam** (Service Definition + registered providers + consumer) lost because exactly one transport exists: the v2 contract is identical across proxy, Cloud, and serverless, so a `baseUrl` switch covers every known deployment. A registry of one would be unowned generality; if a second transport ever appears, the seam can split then (pre-release stance).
- **The first-party `comfy-mcp` server** (stdio MCP, driven through `dsh-mcp-client`) lost on fit for the deployed topology: it wraps `comfy-cli` against a local workspace, only a closed subset of its tools is remoted behind `COMFYUI_URL`, and discovery/validation tools would act on a workspace that does not exist beside a containerized ComfyUI. The MCP route suits clients without a native integration; the harness has one. Revisit if `comfy-mcp` grows a base-URL transport.
- **Driving the ComfyUI server's legacy endpoints directly** (`/prompt`, `/queue`, `/history`, websocket) lost to the v2 contract's durability, idempotent submission, content-addressed assets with `core/ASSET` graph references, and additive-only versioning promise; the legacy surface also has no authentication path, while v2 carries an optional bearer token.

## Consequences

Agents gain end-to-end generation: discover models and node schemas, submit graphs, block for or poll results, cancel, and feed local files in as assets. The cost is the two-endpoint deployment requirement: self-hosted users must run comfy-api-proxy (or point `baseUrl` at Comfy Cloud), and discovery needs the ComfyUI server reachable separately. The capability trusts the endpoint's job validation rather than duplicating graph checks client-side, so an invalid graph costs one rejected request — its structured per-node errors are the feedback loop. Known gaps recorded in the package READMEs: proxy-reported output sizes are currently zero, assets have no byte-download operation, and `comfy_get_job` waits in the foreground rather than through the `ctx.jobs` runtime.
