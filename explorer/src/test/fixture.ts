import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildModel } from '../model/build'
import { loadSnapshot } from '../snapshot/load'

export const fixturePath = fileURLToPath(new URL('../../../fixtures/demo-contract.ionx', import.meta.url))

export const fixtureBytes = () => new Uint8Array(readFileSync(fixturePath))

export async function fixtureModel() {
  return buildModel(await loadSnapshot(fixtureBytes()))
}

export const previousFixturePath = fileURLToPath(new URL('../../../fixtures/demo-contract-previous.ionx', import.meta.url))

/** The demo contract two weeks earlier (see exporter/internal/fixture/history.go). */
export async function previousFixtureModel() {
  return buildModel(await loadSnapshot(new Uint8Array(readFileSync(previousFixturePath))))
}
