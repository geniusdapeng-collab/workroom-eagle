"use strict";
const { contextBridge, ipcRenderer } = require("electron");

// 只公开用途固定的接口；不向网页暴露 ipcRenderer、文件系统或模型密钥。
contextBridge.exposeInMainWorld("workloomDesktop", Object.freeze({
  session: () => ipcRenderer.invoke("workloom:production-session"),
  configuration: () => ipcRenderer.invoke("workloom:production-configuration"),
  openAgentGuide: () => ipcRenderer.invoke("workloom:open-agent-guide"),
}));
