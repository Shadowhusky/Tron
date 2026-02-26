// Re-sign the app bundle with --deep AFTER electron-builder's own signing,
// but ONLY for ad-hoc (unsigned) builds. When a real Developer ID certificate
// is used, electron-builder handles signing correctly — skip the hook.

const { execSync } = require("child_process");
const path = require("path");

module.exports = async function afterSign(context) {
  // Only run for macOS targets (not Windows/Linux built on macOS)
  if (context.packager.platform.name !== "mac") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  // Check if the app was signed with a real identity (not ad-hoc)
  try {
    const info = execSync(`codesign -dv "${appPath}" 2>&1`, {
      encoding: "utf-8",
    });
    // If signed with a real Developer ID, don't re-sign
    if (!info.includes("Signature=adhoc")) {
      console.log("[afterSign] App signed with real identity, skipping deep re-sign");
      return;
    }
  } catch {
    // If codesign check fails, proceed with re-sign
  }

  console.log(`[afterSign] Re-signing ${appPath} with --deep ad-hoc signature`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, {
    stdio: "inherit",
  });
};
