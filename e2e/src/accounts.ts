import { createPublicClient, createWalletClient, defineChain, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const RPC_URL = 'http://127.0.0.1:8545'

// anvil default mnemonic "test test test test test test test test test test test junk" accounts.
const PRIVATE_KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  maker: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  eoa: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
} as const

export type AccountName = keyof typeof PRIVATE_KEYS

const anvilChain = defineChain({
  id: 31337,
  name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
})

export function publicClient() {
  return createPublicClient({ chain: anvilChain, transport: http(RPC_URL) })
}

export function wallet(name: AccountName) {
  return createWalletClient({
    account: privateKeyToAccount(PRIVATE_KEYS[name]),
    chain: anvilChain,
    transport: http(RPC_URL),
  })
}

export function accountAddress(name: AccountName): `0x${string}` {
  return privateKeyToAccount(PRIVATE_KEYS[name]).address
}
