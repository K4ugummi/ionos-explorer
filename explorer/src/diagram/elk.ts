import ELK, { type ELK as ElkApi } from 'elkjs/lib/elk-api'
import workerUrl from 'elkjs/lib/elk-worker.min.js?url'

let instance: ElkApi | undefined

/** ELK in a web worker, so large layouts do not block the UI. */
export function elk(): ElkApi {
  instance ??= new ELK({ workerUrl })
  return instance
}
