// The lane compressor's AudioWorklet (compressor.ts does the work). Loaded once per context by
// `loadComp` (graph.ts); one node per compressed lane. Its settings are k-rate parameters.

import { COMP_DEFAULTS, COMP_NODE, Compressor } from './compressor'

// The AudioWorkletGlobalScope (not in TypeScript's DOM library).
declare const sampleRate: number
declare function registerProcessor(name: string, ctor: unknown): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}

class LaneCompProcessor extends AudioWorkletProcessor {
  private comp = new Compressor()

  static get parameterDescriptors() {
    return Object.entries(COMP_DEFAULTS).map(([name, defaultValue]) => ({ name, defaultValue, automationRate: 'k-rate' }))
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean {
    this.comp.process(inputs[0] ?? [], outputs[0], {
      thresholdDb: params.threshold[0], ratio: params.ratio[0], kneeDb: params.knee[0],
      attackMs: params.attack[0], releaseMs: params.release[0], makeupDb: params.makeup[0],
    }, sampleRate)
    return true
  }
}

registerProcessor(COMP_NODE, LaneCompProcessor)
