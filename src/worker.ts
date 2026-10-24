import { parentPort } from 'node:worker_threads'
import { decodeReplay } from './protocol/decoder.js'

interface DecodeMessage {
  id: number
  buffer: ArrayBuffer
  fileName: string
  includeFrames: boolean
}

parentPort?.on('message', (message: DecodeMessage) => {
  try {
    const report = decodeReplay(new Uint8Array(message.buffer), message.fileName, {
      includeFrames: message.includeFrames,
    })
    parentPort?.postMessage({ id: message.id, json: JSON.stringify(report) })
  } catch (error) {
    parentPort?.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
