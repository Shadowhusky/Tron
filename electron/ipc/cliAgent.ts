import { ipcMain, type WebContents } from "electron";
import { CliAgentManager } from "./cliAgentCore";

const manager = new CliAgentManager();
const watched = new Set<number>();

/** A run belongs to the renderer that started it: a reload, crash or close of
 *  that renderer loses the run's UI state, so its runs are stopped. */
function ownerFor(wc: WebContents): string {
  const owner = `wc-${wc.id}`;
  if (!watched.has(wc.id)) {
    watched.add(wc.id);
    const stop = () => manager.stopAll(owner);
    wc.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) stop();
    });
    wc.on("render-process-gone", stop);
    wc.once("destroyed", () => {
      stop();
      watched.delete(wc.id);
    });
  }
  return owner;
}

export function registerCliAgentHandlers() {
  ipcMain.handle("cliAgent.detect", (_event, force) => manager.detect(force === true));
  ipcMain.handle("cliAgent.start", (event, data) => {
    const wc = event.sender;
    return manager.start(data, (ev) => {
      if (!wc.isDestroyed()) wc.send("cliAgent.event", ev);
    }, ownerFor(wc));
  });
  ipcMain.handle("cliAgent.respond", (_event, data) => manager.respond(data));
  ipcMain.handle("cliAgent.stop", (_event, runId) => manager.stop(runId));
  ipcMain.handle("cliAgent.complete", (_event, data) => manager.complete(data));
}

export function cleanupAllCliAgentRuns() {
  manager.stopAll();
}
