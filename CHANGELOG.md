# Changelog

## [0.4.0](https://github.com/chrischall/myhotlunchbox-mcp/compare/v0.3.0...v0.4.0) (2026-09-01)


### Features

* **health:** add mhlb_healthcheck ([#37](https://github.com/chrischall/myhotlunchbox-mcp/issues/37)) ([e7f32b8](https://github.com/chrischall/myhotlunchbox-mcp/commit/e7f32b839a394b1051c066a5408fed8cb5a79a8a))


### Documentation

* **health:** list mhlb_healthcheck in the README, and use the shared harness ([#40](https://github.com/chrischall/myhotlunchbox-mcp/issues/40)) ([683c82c](https://github.com/chrischall/myhotlunchbox-mcp/commit/683c82c10355715068979af756a32cb6822a6ccb))

## [0.3.0](https://github.com/chrischall/myhotlunchbox-mcp/compare/v0.2.1...v0.3.0) (2026-08-28)


### Features

* cache the OAuth token pair so a restart skips the password grant ([#22](https://github.com/chrischall/myhotlunchbox-mcp/issues/22)) ([cb778e6](https://github.com/chrischall/myhotlunchbox-mcp/commit/cb778e6af1869facb95d27375637f1951b81a3f7))


### Documentation

* list the cache env vars in server.json and .env.example ([#27](https://github.com/chrischall/myhotlunchbox-mcp/issues/27)) ([412622f](https://github.com/chrischall/myhotlunchbox-mcp/commit/412622fefc5c2405269d6909757f1c93c5964f3a))
* **mint:** correct a claim the token cache made false ([#26](https://github.com/chrischall/myhotlunchbox-mcp/issues/26)) ([526e71b](https://github.com/chrischall/myhotlunchbox-mcp/commit/526e71b1c2ce7ac9c8791bda550f30fb9b9085db))
* **server.json:** declare isSecret on the token-cache env vars ([#29](https://github.com/chrischall/myhotlunchbox-mcp/issues/29)) ([c6099ef](https://github.com/chrischall/myhotlunchbox-mcp/commit/c6099ef7c0820d0ab58fbd6b88b1bc797bbdda80))

## [0.2.1](https://github.com/chrischall/myhotlunchbox-mcp/compare/v0.2.0...v0.2.1) (2026-08-25)


### Bug Fixes

* capture the real write payloads, and correct four that were guesses ([#16](https://github.com/chrischall/myhotlunchbox-mcp/issues/16)) ([784c1ce](https://github.com/chrischall/myhotlunchbox-mcp/commit/784c1ce24ee891106d51246636780c8ad5c64186))


### Documentation

* stop mint.yaml pointing at names the rename is about to change ([#19](https://github.com/chrischall/myhotlunchbox-mcp/issues/19)) ([d06c5fa](https://github.com/chrischall/myhotlunchbox-mcp/commit/d06c5fa3e562120690b9cec8d069fb639aaecdf1))

## [0.2.0](https://github.com/chrischall/myhotlunchbox-mcp/compare/v0.1.1...v0.2.0) (2026-08-24)


### Features

* declare hosting requirements in mcp-host.yaml ([#10](https://github.com/chrischall/myhotlunchbox-mcp/issues/10)) ([7044ff1](https://github.com/chrischall/myhotlunchbox-mcp/commit/7044ff1b8eab050d1a2c2bf3eec7866800baadc4))


### Documentation

* make the mint.yaml filename note durable ([#14](https://github.com/chrischall/myhotlunchbox-mcp/issues/14)) ([8364139](https://github.com/chrischall/myhotlunchbox-mcp/commit/836413942985f3c57f515217bc7e06df7e16b613))

## [0.1.1](https://github.com/chrischall/myhotlunchbox-mcp/compare/v0.1.0...v0.1.1) (2026-08-24)


### Bug Fixes

* make report writes atomic and stop verify-reads exiting 0 on partial runs ([#7](https://github.com/chrischall/myhotlunchbox-mcp/issues/7)) ([2a70a52](https://github.com/chrischall/myhotlunchbox-mcp/commit/2a70a5232e805e04fdd5c905a4d8477e2d3fd2ab))
* validate report bodies by magic bytes, not content-type ([#5](https://github.com/chrischall/myhotlunchbox-mcp/issues/5)) ([4ae67e9](https://github.com/chrischall/myhotlunchbox-mcp/commit/4ae67e99faef8f8b89127bd354f2a423a3ccd61a))

## 0.1.0 (2026-08-24)


### Features

* My Hot Lunchbox MCP server and shell skill ([e5475d8](https://github.com/chrischall/myhotlunchbox-mcp/commit/e5475d85abeda62963c1af058b61ddc48c3bd078))


### Bug Fixes

* correct endpoints and payloads found by live verification ([#2](https://github.com/chrischall/myhotlunchbox-mcp/issues/2)) ([90bfecc](https://github.com/chrischall/myhotlunchbox-mcp/commit/90bfeccd96abd5d1fc328088acb34656b68c0d8d))
