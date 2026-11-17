/// <reference types="vite/client" />

// API exposée par le preload (contextBridge) : son type suit celui de l'objet construit dans electron/preload.cts.
interface Window {
  readonly workbench: import('../electron/preload.cts').WorkbenchApi;
}
