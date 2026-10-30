import type { DrumvaultAPI } from './types/api'

declare global {
  interface Window {
    drumvault: DrumvaultAPI
  }
}

export const api: DrumvaultAPI = window.drumvault
