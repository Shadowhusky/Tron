"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCliAgentHandlers = registerCliAgentHandlers;
exports.cleanupAllCliAgentRuns = cleanupAllCliAgentRuns;
const electron_1 = require("electron");
const cliAgentCore_1 = require("./cliAgentCore");
const manager = new cliAgentCore_1.CliAgentManager();
const watched = new Set();
/** A run belongs to the renderer that started it: a reload, crash or close of
 *  that renderer loses the run's UI state, so its runs are stopped. */
function ownerFor(wc) {
    const owner = `wc-${wc.id}`;
    if (!watched.has(wc.id)) {
        watched.add(wc.id);
        const stop = () => manager.stopAll(owner);
        wc.on("did-start-navigation", (details) => {
            if (details.isMainFrame && !details.isSameDocument)
                stop();
        });
        wc.on("render-process-gone", stop);
        wc.once("destroyed", () => {
            stop();
            watched.delete(wc.id);
        });
    }
    return owner;
}
function registerCliAgentHandlers() {
    electron_1.ipcMain.handle("cliAgent.detect", (_event, force) => manager.detect(force === true));
    electron_1.ipcMain.handle("cliAgent.start", (event, data) => {
        const wc = event.sender;
        return manager.start(data, (ev) => {
            if (!wc.isDestroyed())
                wc.send("cliAgent.event", ev);
        }, ownerFor(wc));
    });
    electron_1.ipcMain.handle("cliAgent.respond", (_event, data) => manager.respond(data));
    electron_1.ipcMain.handle("cliAgent.stop", (_event, runId) => manager.stop(runId));
    electron_1.ipcMain.handle("cliAgent.complete", (_event, data) => manager.complete(data));
}
function cleanupAllCliAgentRuns() {
    manager.stopAll();
}
//# sourceMappingURL=cliAgent.js.map