/// <reference types="vite/client" />

// Electron preload bridge exposed on window.api
interface Window {
  api: any
}
