import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const target = join(root, 'dist', 'protocol')
mkdirSync(target, { recursive: true })
for (const file of ['replaySchema.json', 'assetCatalog.json']) {
  cpSync(join(root, 'src', 'protocol', file), join(target, file))
}
