import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(E2E_DIR, '..')
const FOUNDRY_BIN = path.join(process.env.HOME ?? '', '.foundry', 'bin')

const RPC_URL = 'http://127.0.0.1:8545'
const ANVIL_PORT = 8545

// anvil default mnemonic account 0
const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

let anvil: ChildProcess | undefined

function rpcBlockNumber(): Promise<unknown> {
  return fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  })
    .then((r) => r.json() as Promise<{ result?: unknown; error?: { message?: string } }>)
    .then((j) => {
      if (j.error) throw new Error(`anvil rpc error: ${JSON.stringify(j.error)}`)
      return j.result
    })
}

async function waitForAnvil(timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      await rpcBlockNumber()
      return
    } catch (err) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`anvil did not become ready within ${timeoutMs}ms: ${String(err)}`)
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: `${FOUNDRY_BIN}:${process.env.PATH}` }
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

export async function setup(): Promise<void> {
  anvil = spawn(
    path.join(FOUNDRY_BIN, 'anvil'),
    ['--host', '127.0.0.1', '--port', String(ANVIL_PORT), '--chain-id', '31337'],
    { detached: true, stdio: 'ignore' },
  )
  anvil.on('error', (err) => {
    console.error('failed to start anvil', err)
    process.exit(1)
  })

  await waitForAnvil()

  await run(
    path.join(FOUNDRY_BIN, 'forge'),
    [
      'script',
      'script/DeployE2e.s.sol',
      '--broadcast',
      '--rpc-url',
      RPC_URL,
      '--private-key',
      DEPLOYER_PK,
    ],
    REPO_ROOT,
  )

  const addressesPath = path.join(REPO_ROOT, 'deployments', 'e2e.json')
  if (!existsSync(addressesPath)) {
    throw new Error(`deploy did not produce ${addressesPath}`)
  }
}

export async function teardown(): Promise<void> {
  if (anvil?.pid) {
    try {
      process.kill(-anvil.pid, 'SIGKILL')
    } catch {
      anvil.kill('SIGKILL')
    }
    anvil = undefined
  }
}
