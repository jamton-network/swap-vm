import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface DeployedAddresses {
  aqua: `0x${string}`
  router: `0x${string}`
  fot: `0x${string}`
  regular: `0x${string}`
  resolver: `0x${string}`
  treasury: `0x${string}`
  owner: `0x${string}`
  feeBps: string
  feeFloor: boolean
  chainId: string
}

export interface E2EContext {
  rpcUrl: string
  addresses: DeployedAddresses
  accounts: {
    deployer: `0x${string}`
    maker: `0x${string}`
    eoa: `0x${string}`
  }
}

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SRC_DIR, '..', '..')
const ADDRESSES_PATH = path.join(REPO_ROOT, 'deployments', 'e2e.json')

let cached: E2EContext | undefined

export function getContext(): E2EContext {
  if (!cached) {
    const addresses = JSON.parse(readFileSync(ADDRESSES_PATH, 'utf8')) as DeployedAddresses
    cached = {
      rpcUrl: 'http://127.0.0.1:8545',
      addresses,
      accounts: {
        deployer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        maker: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        eoa: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      },
    }
  }
  return cached
}
