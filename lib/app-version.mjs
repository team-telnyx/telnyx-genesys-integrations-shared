// Next replaces this expression at build time (see `env` in next.config.mjs),
// which is what makes the identity a compile-time constant. The running app
// must never read package.json, Git, the clock, or a remote "latest release"
// endpoint: a deployed bundle describes the source it was compiled from, and
// nothing about the environment it happens to be running in can change that.
export const APP_BUILD = Object.freeze(JSON.parse(process.env.NEXT_PUBLIC_GI_BUILD_INFO || "null"));

export function versionInfoText(info = APP_BUILD) {
  if (!info) return "Genesys Integrations version information unavailable";
  return [
    `Telnyx Genesys Integrations ${info.displayVersion}`,
    `Build: ${info.buildId}`,
    `Commit: ${info.commit || "Unavailable"}`,
    `Built at: ${info.builtAt}`,
    `Channel: ${info.channel}`,
    `Working tree: ${info.dirty === null ? "Unknown" : info.dirty ? "Modified" : "Clean"}`,
  ].join("\n");
}
