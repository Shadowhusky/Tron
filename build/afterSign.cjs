// Re-sign the app bundle with --deep AFTER electron-builder's own signing.
// electron-builder signs without --deep, so the main binary and embedded
// frameworks (Electron Framework, etc.) end up with inconsistent ad-hoc
// signatures, causing macOS App Translocation Team ID mismatch crashes.

const { execSync } = require("child_process");
const path = require("path");

module.exports = async function afterSign(context) {
  // Only needed on macOS and only for unsigned (ad-hoc) builds
  if (process.platform !== "darwin") return;

  // If a real signing identity is configured, electron-builder handles it
  const identity = context.packager.platformSpecificBuildOptions.identity;
  if (identity && identity !== "-") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  console.log(`[afterSign] Re-signing ${appPath} with --deep ad-hoc signature`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, {
    stdio: "inherit",
  });
};
