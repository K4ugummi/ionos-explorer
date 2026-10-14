// Mirrors exporter/internal/snapshot/manifest.go and schema/manifest.schema.json.

export const SUPPORTED_FORMAT_VERSION = 1

export type CoverageStatus = 'ok' | 'forbidden' | 'not_found' | 'error' | 'skipped'

export interface Manifest {
  formatVersion: number
  createdAt: string
  generator: { name: string; version: string }
  synthetic: boolean
  contract?: { number: number; owner?: string }
  apis: { id: string; name: string; version: string; baseUrl: string; region?: string }[]
  coverage: Coverage[]
  files: { path: string; size: number; sha256: string }[]
}

export interface Coverage {
  api: string
  endpoint: string
  path: string
  query?: string
  status: CoverageStatus
  httpStatus?: number
  file?: string
  items?: number
  pages?: number
  error?: string
}

export interface Snapshot {
  manifest: Manifest
  /** Parsed raw API documents keyed by container path (raw/...). */
  files: Map<string, unknown>
}
