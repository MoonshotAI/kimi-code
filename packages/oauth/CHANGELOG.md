# @moonshot-ai/kimi-code-oauth

## 0.4.0

### Minor Changes

- [#2885](https://github.com/MoonshotAI/kimi-code/pull/2885) [`4a93f70`](https://github.com/MoonshotAI/kimi-code/commit/4a93f70aa2cf5f70a88b4f8eeb2e409aab2c8f59) Thanks [@liruifengv](https://github.com/liruifengv)! - Add a browser-safe `./device` subpath export exposing the device-code flow's pure-fetch HTTP wrappers and flow config, so browser bundles can run OAuth sign-in without pulling in Node-only modules. Import from `@moonshot-ai/kimi-code-oauth/device`.

### Patch Changes

- [#2351](https://github.com/MoonshotAI/kimi-code/pull/2351) [`6be2697`](https://github.com/MoonshotAI/kimi-code/commit/6be26978b123bacf1c5ebce52bbeb6f7b7ff0629) Thanks [@7Sageer](https://github.com/7Sageer)! - Add `fetchChatTitle` for the managed platform `/tools` `chat_title` method: protocol headers, an 8s timeout, response validation, and structured failures.

## 0.3.0

### Minor Changes

- [#2382](https://github.com/MoonshotAI/kimi-code/pull/2382) [`40172c7`](https://github.com/MoonshotAI/kimi-code/commit/40172c7ca96ca981b043b793588dd32e898979fa) Thanks [@liruifengv](https://github.com/liruifengv)! - Rework the host identity type: rename `userAgentProduct` to `productName` and add a required `platform` field, so every host explicitly declares the `X-Msh-Platform` value it reports instead of silently inheriting the CLI's. OAuth requests now also send the product User-Agent (with the optional runtime suffix), so the OAuth host can tell client families and surfaces apart.

## 0.2.2

### Patch Changes

- [#399](https://github.com/MoonshotAI/kimi-code/pull/399) [`232ed87`](https://github.com/MoonshotAI/kimi-code/commit/232ed874d41de777e6ff9c539ac22d830d0b5c3a) - Keep managed OAuth credentials scoped to their configured authentication and API endpoints.

## 0.2.1

### Patch Changes

- [#335](https://github.com/MoonshotAI/kimi-code/pull/335) [`7284f30`](https://github.com/MoonshotAI/kimi-code/commit/7284f30479142fd66b1e8a731fd00198b1e8684f) - Fix custom registry provider handling during re-import. Prevent loss of multi-provider entries and remove stale providers along with their model aliases and default model references.

## 0.2.0

### Minor Changes

- [#264](https://github.com/MoonshotAI/kimi-code/pull/264) [`42bb914`](https://github.com/MoonshotAI/kimi-code/commit/42bb9141d8ee7023639f943dd4c6a0f6c8fa8945) - Add `/provider` command for managing AI providers, support custom registry imports, and introduce a tabbed model selector.

### Patch Changes

- [#274](https://github.com/MoonshotAI/kimi-code/pull/274) [`a1dfbfe`](https://github.com/MoonshotAI/kimi-code/commit/a1dfbfeb16bcad0c2c8faa232d6d1ce4a2681d57) - Clarify Kimi Platform API key login labels and prompt details.

## 0.1.2

### Patch Changes

- [#52](https://github.com/MoonshotAI/kimi-code/pull/52) [`064343a`](https://github.com/MoonshotAI/kimi-code/commit/064343a6e565a525fbf38b3a1f70f7ff0235a5ed) - Correct the `X-Msh-Platform` header value to `kimi_code_cli`.

- [#11](https://github.com/MoonshotAI/kimi-code/pull/11) [`15b018f`](https://github.com/MoonshotAI/kimi-code/commit/15b018fc84a36a9ebde598970e5b44bebe5d68c6) - Surface API-provided error messages during feedback, usage, login, and model setup failures.
