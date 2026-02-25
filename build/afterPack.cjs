// Re-sign the app bundle with --deep after packing.
// Ensures main binary and all embedded frameworks (Electron Framework, etc.)
// share a consistent ad-hoc signature, preventing macOS App Translocation
// Team ID mismatch crashes on unsigned builds.

const { execSync } = require("child_process");
const path = require("path");

module.exports = async function afterPack(context) {
  // Only needed on macOS and only for unsigned (ad-hoc) builds
  if (process.platform !== "darwin") return;

  // If a real signing identity is configured, electron-builder handles it
  const identity = context.packager.platformSpecificBuildOptions.identity;
  if (identity && identity !== "-") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  console.log(`[afterPack] Re-signing ${appPath} with --deep ad-hoc signature`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, {
    stdio: "inherit",
  });
};
