// Patch node-pty's unixTerminal.js in app.asar.unpacked to fix spawn-helper
// path resolution. node-pty does:
//
//   helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');
//
// This is intended for when JS files are inside app.asar and native modules
// are in app.asar.unpacked. But when the ENTIRE node_modules is unpacked
// (as in our config), __dirname already contains 'app.asar.unpacked', and
// the replacement corrupts it to 'app.asar.unpacked.unpacked' — a path
// that doesn't exist, causing posix_spawnp to fail.
//
// This hook patches the replacement to be safe by using a negative lookahead
// regex that only matches 'app.asar' when NOT already followed by '.unpacked'.

const fs = require("fs");
const path = require("path");

module.exports = async function afterPack(context) {
  const unpackedDir = path.join(
    context.appOutDir,
    // macOS .app bundle path
    context.packager.platform.name === "mac"
      ? `${context.packager.appInfo.productFilename}.app/Contents/Resources/app.asar.unpacked`
      : "resources/app.asar.unpacked",
  );

  const unixTerminalPath = path.join(
    unpackedDir,
    "node_modules/node-pty/lib/unixTerminal.js",
  );

  if (!fs.existsSync(unixTerminalPath)) {
    console.log("[afterPack] node-pty unixTerminal.js not found, skipping patch");
    return;
  }

  let content = fs.readFileSync(unixTerminalPath, "utf-8");

  // Replace the unsafe string replacement with a regex that uses negative lookahead
  const oldCode = "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');";
  const newCode = "helperPath = helperPath.replace(/app\\.asar(?!\\.unpacked)/g, 'app.asar.unpacked');";

  if (content.includes(oldCode)) {
    content = content.replace(oldCode, newCode);
    fs.writeFileSync(unixTerminalPath, content, "utf-8");
    console.log("[afterPack] Patched node-pty unixTerminal.js (fixed app.asar.unpacked double-replace)");
  } else if (content.includes("app.asar.unpacked")) {
    console.log("[afterPack] node-pty unixTerminal.js already patched or uses different pattern");
  } else {
    console.log("[afterPack] node-pty unixTerminal.js does not contain asar replacement code");
  }

  // Also fix the node_modules.asar replacement (same issue)
  const oldCode2 = "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');";
  const newCode2 = "helperPath = helperPath.replace(/node_modules\\.asar(?!\\.unpacked)/g, 'node_modules.asar.unpacked');";

  if (content.includes(oldCode2)) {
    content = content.replace(oldCode2, newCode2);
    fs.writeFileSync(unixTerminalPath, content, "utf-8");
    console.log("[afterPack] Patched node-pty node_modules.asar replacement too");
  }
};
