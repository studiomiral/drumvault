// The lane compressor's AudioWorklet and the drum bus's detector (compressor.ts does the work).
// Loaded once per context by `loadComp` (graph.ts); one node per compressed lane, one detector per
// bus. Their settings are k-rate parameters.

import { BUS_NODE, COMP_DEFAULTS, COMP_NODE, Compressor, type CompParams } from './compressor'

// The AudioWorkletGlobalScope (not in TypeScript's DOM library).
declare const sampleRate: number
declare function registerProcessor(name: string, ctor: unknown): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}

const descriptors = () => Object.entries(COMP_DEFAULTS).map(([name, defaultValue]) => ({ name, defaultValue, automationRate: 'k-rate' }))
const paramsOf = (p: Record<string, Float32Array>): CompParams => ({
  thresholdDb: p.threshold[0], ratio: p.ratio[0], kneeDb: p.knee[0],
  attackMs: p.attack[0], releaseMs: p.release[0], makeupDb: p.makeup[0], detectMs: p.detect[0],
})

class LaneCompProcessor extends AudioWorkletProcessor {
  private comp = new Compressor()
  static get parameterDescriptors() { return descriptors() }

  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean {
    this.comp.process(inputs[0] ?? [], outputs[0], paramsOf(params), sampleRate)
    return true
  }
}

class BusDetectProcessor extends AudioWorkletProcessor {
  private comp = new Compressor()
  static get parameterDescriptors() { return descriptors() }

  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean {
    const g = outputs[0][0]
    this.comp.gains(inputs[0] ?? [], g, g.length, paramsOf(params), sampleRate)
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(g)
    return true
  }
}

registerProcessor(COMP_NODE, LaneCompProcessor)
registerProcessor(BUS_NODE, BusDetectProcessor)
