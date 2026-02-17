import fs from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";

export async function fixPermissions(): Promise<boolean> {
  if (process.platform !== "darwin") return true;

  const nodePtyPath = path.join(__dirname, "../../node_modules/node-pty");
  const fixCommand = `chmod -R +x "${nodePtyPath}"`;

  try {
    await new Promise<void>((resolve, reject) => {
      exec(fixCommand, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return true;
  } catch (error) {
    console.error("Failed to fix permissions:", error);
    return false;
  }
}

export async function checkPermissions(): Promise<boolean> {
  if (process.platform !== "darwin") return true;

  try {
    await fs.promises.access(
      "/Library/Preferences/com.apple.TimeMachine.plist",
      fs.constants.R_OK
    );
    return true;
  } catch {
    try {
      const safariPath = path.join(os.homedir(), "Library/Safari");
      await fs.promises.readdir(safariPath);
      return true;
    } catch {
      return false;
    }
  }
}

export async function openPrivacySettings(): Promise<void> {
  // No-op in web mode — can't open system preferences remotely
  return;
}
