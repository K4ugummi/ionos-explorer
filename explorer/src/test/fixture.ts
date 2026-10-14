import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildModel } from '../model/build'
import { loadSnapshot } from '../snapshot/load'

export const fixturePath = fileURLToPath(new URL('../../../fixtures/demo-contract.ionx', import.meta.url))

export const fixtureBytes = () => new Uint8Array(readFileSync(fixturePath))

export async function fixtureModel() {
  return buildModel(await loadSnapshot(fixtureBytes()))
}
