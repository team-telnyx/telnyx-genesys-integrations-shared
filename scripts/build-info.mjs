import { createBuildInfo } from "./lib/build-info.mjs";

// Compact JSON, suitable for the GI_BUILD_INFO build argument and for artifact
// manifests. `env: {}` is deliberate: always recapture the host checkout, even
// when a previous build exported a snapshot into the environment, so a stale
// value can never be passed forward as if it described this build.
console.log(JSON.stringify(createBuildInfo({ env: {} })));
