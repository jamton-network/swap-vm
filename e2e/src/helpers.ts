import { Address } from '@1inch/sdk-core'
import { MakerTraits, Order, TakerTraits, type SwapVmProgram } from '@1inch/swap-vm-sdk'
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Abi } from 'viem'
import { accountAddress, publicClient, wallet } from './accounts'
import { getContext } from './context'
import { buildBidirectionalProgram } from './instructions'

export { accountAddress }

export const FOT_BALANCE = 1000n * 10n ** 18n
export const REGULAR_BALANCE = 2000n * 10n ** 18n
export const FEE_DENOM = 1_000_000_000n
export const MAX_UINT256 = 2n ** 256n - 1n

const ORDER_TUPLE = '(address maker, uint256 traits, bytes data)'

export const TOKEN_ABI = parseAbi([
  'function mint(address account, uint256 amount) external',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
]) as Abi

export const ROUTER_ABI = parseAbi([
  `function quote(${ORDER_TUPLE} order, address tokenIn, address tokenOut, uint256 amount, bytes takerTraitsAndData) external view returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)`,
  `function swap(${ORDER_TUPLE} order, address tokenIn, address tokenOut, uint256 amount, bytes takerTraitsAndData) external returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)`,
]) as Abi

export const AQUA_ABI = parseAbi([
  'function ship(address app, bytes strategy, address[] tokens, uint256[] amounts) external returns (bytes32 strategyHash)',
  'function dock(address app, bytes32 strategyHash, address[] tokens) external',
  'function safeBalances(address maker, address app, bytes32 strategyHash, address token0, address token1) external view returns (uint256 balance0, uint256 balance1)',
  'function rawBalances(address maker, address app, bytes32 strategyHash, address token) external view returns (uint248 balance, uint8 tokensCount)',
]) as Abi

export const MOCK_TAKER_ABI = parseAbi([
  `function swap(${ORDER_TUPLE} order, address tokenIn, address tokenOut, uint256 amount, bytes takerTraitsAndData) external returns (uint256 amountIn, uint256 amountOut)`,
]) as Abi

// ---------- math (mirrors FeeOnTransfer.t.sol) ----------

export function ceilDiv(x: bigint, y: bigint): bigint {
  return (x + y - 1n) / y
}

export function transferFee(amount: bigint, feeBps: bigint, feeFloor: boolean): bigint {
  return feeFloor ? (amount * feeBps) / FEE_DENOM : ceilDiv(amount * feeBps, FEE_DENOM)
}

export function grossUp(net: bigint, feeBps: bigint): bigint {
  return ceilDiv(net * feeBps, FEE_DENOM - feeBps)
}

export function doubleFee(amount: bigint, feeBps: bigint, feeFloor: boolean): bigint {
  const fee1 = transferFee(amount, feeBps, feeFloor)
  return fee1 + transferFee(amount - fee1, feeBps, feeFloor)
}

// ---------- order / traits ----------

export function makeOrder(maker: string, program: SwapVmProgram): Order {
  return Order.new({ maker: new Address(maker), traits: MakerTraits.default(), program })
}

export function resolverTakerTraits(exactIn: boolean): TakerTraits {
  return TakerTraits.new({ exactIn, useTransferFromAndAquaPush: false, preTransferInCallbackEnabled: true })
}

export function eoaTakerTraits(exactIn: boolean): TakerTraits {
  return TakerTraits.new({ exactIn, useTransferFromAndAquaPush: true })
}

// ---------- primitives ----------

export async function mintTo(token: `0x${string}`, to: `0x${string}`, amount: bigint): Promise<void> {
  const deployer = wallet('deployer')
  const hash = await deployer.writeContract({
    address: token,
    abi: TOKEN_ABI,
    functionName: 'mint',
    args: [to, amount],
  })
  await publicClient().waitForTransactionReceipt({ hash })
}

export async function approve(
  spender: `0x${string}`,
  token: `0x${string}`,
  from: ReturnType<typeof wallet>,
): Promise<void> {
  const hash = await from.writeContract({
    address: token,
    abi: TOKEN_ABI,
    functionName: 'approve',
    args: [spender, MAX_UINT256],
  })
  await publicClient().waitForTransactionReceipt({ hash })
}

export async function tokenBalance(token: `0x${string}`, who: `0x${string}`): Promise<bigint> {
  const data = encodeFunctionData({ abi: TOKEN_ABI, functionName: 'balanceOf', args: [who] })
  const result = await publicClient().call({ to: token, data })
  return decodeFunctionResult({ abi: TOKEN_ABI, functionName: 'balanceOf', data: result.data as `0x${string}` }) as bigint
}

/** Asserts that the given promise rejects (used for expected revert checks). */
export async function expectRevert(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toThrow()
}

export async function aquaSafeBalances(
  strategyHash: `0x${string}`,
  token0: `0x${string}`,
  token1: `0x${string}`,
): Promise<[bigint, bigint]> {
  const { aqua, router } = getContext().addresses
  const maker = accountAddress('maker')
  const data = encodeFunctionData({
    abi: AQUA_ABI,
    functionName: 'safeBalances',
    args: [maker, router, strategyHash, token0, token1],
  })
  const result = await publicClient().call({ to: aqua, data })
  return decodeFunctionResult({ abi: AQUA_ABI, functionName: 'safeBalances', data: result.data as `0x${string}` }) as [bigint, bigint]
}

export async function aquaRawBalances(
  strategyHash: `0x${string}`,
  token: `0x${string}`,
): Promise<[bigint, number]> {
  const { aqua, router } = getContext().addresses
  const maker = accountAddress('maker')
  const data = encodeFunctionData({
    abi: AQUA_ABI,
    functionName: 'rawBalances',
    args: [maker, router, strategyHash, token],
  })
  const result = await publicClient().call({ to: aqua, data })
  return decodeFunctionResult({ abi: AQUA_ABI, functionName: 'rawBalances', data: result.data as `0x${string}` }) as [
    bigint,
    number,
  ]
}

// ---------- order / ship / quote / swap ----------

export interface QuoteResult {
  amountIn: bigint
  amountOut: bigint
  orderHash: `0x${string}`
}

export interface SwapResult {
  amountIn: bigint
  amountOut: bigint
}

export async function ship(
  order: Order,
  fot: `0x${string}`,
  regular: `0x${string}`,
  fotAmount: bigint,
  regularAmount: bigint,
): Promise<`0x${string}`> {
  const { aqua, router } = getContext().addresses
  const maker = wallet('maker')

  await approve(aqua, fot, maker)
  await approve(aqua, regular, maker)

  const hash = await maker.writeContract({
    address: aqua,
    abi: AQUA_ABI,
    functionName: 'ship',
    args: [router, order.encode().toString(), [fot, regular], [fotAmount, regularAmount]],
  })
  await publicClient().waitForTransactionReceipt({ hash })

  return order.hash().toString() as `0x${string}`
}

export async function dock(strategyHash: `0x${string}`, tokens: `0x${string}`[]): Promise<void> {
  const { aqua, router } = getContext().addresses
  const maker = wallet('maker')
  const hash = await maker.writeContract({
    address: aqua,
    abi: AQUA_ABI,
    functionName: 'dock',
    args: [router, strategyHash, tokens],
  })
  await publicClient().waitForTransactionReceipt({ hash })
}

export async function quote(
  order: Order,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amount: bigint,
  traits: TakerTraits,
): Promise<QuoteResult> {
  const { router } = getContext().addresses
  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'quote',
    args: [order.build(), tokenIn, tokenOut, amount, traits.encode().toString()],
  })
  const result = await publicClient().call({ to: router, data })
  const [amountIn, amountOut, orderHash] = decodeFunctionResult({
    abi: ROUTER_ABI,
    functionName: 'quote',
    data: result.data as `0x${string}`,
  }) as [bigint, bigint, `0x${string}`]
  return { amountIn, amountOut, orderHash }
}

/** EOA (two-hop): the EOA approves the router and calls it directly. */
export async function swapEoa(
  order: Order,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amount: bigint,
  traits: TakerTraits,
): Promise<SwapResult> {
  const { router } = getContext().addresses
  const eoa = wallet('eoa')
  const client = publicClient()

  // The two-hop input leg is a taker->router transferFrom, so the EOA approves the router.
  await approve(router, tokenIn, eoa)

  const args = [order.build(), tokenIn, tokenOut, amount, traits.encode().toString()]
  const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'swap', args })
  const sim = await client.call({ account: eoa.account, to: router, data })
  const [amountIn, amountOut] = decodeFunctionResult({ abi: ROUTER_ABI, functionName: 'swap', data: sim.data as `0x${string}` }) as [
    bigint,
    bigint,
  ]

  const hash = await eoa.writeContract({ address: router, abi: ROUTER_ABI, functionName: 'swap', args })
  await client.waitForTransactionReceipt({ hash })
  return { amountIn, amountOut }
}

/** Resolver (one-hop): the owner drives the MockTaker, which approves Aqua + pushes in its callback. */
export async function swapResolver(
  order: Order,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amount: bigint,
  traits: TakerTraits,
): Promise<SwapResult> {
  const { resolver } = getContext().addresses
  const owner = wallet('deployer')
  const client = publicClient()

  const args = [order.build(), tokenIn, tokenOut, amount, traits.encode().toString()]
  const data = encodeFunctionData({ abi: MOCK_TAKER_ABI, functionName: 'swap', args })
  const sim = await client.call({ account: owner.account, to: resolver, data })
  const [amountIn, amountOut] = decodeFunctionResult({ abi: MOCK_TAKER_ABI, functionName: 'swap', data: sim.data as `0x${string}` }) as [
    bigint,
    bigint,
  ]

  const hash = await owner.writeContract({ address: resolver, abi: MOCK_TAKER_ABI, functionName: 'swap', args })
  await client.waitForTransactionReceipt({ hash })
  return { amountIn, amountOut }
}

export function asAddress(v: string): `0x${string}` {
  return v as `0x${string}`
}

export interface StrategyFixture {
  order: Order
  strategyHash: `0x${string}`
  fot: `0x${string}`
  regular: `0x${string}`
}

/**
 * Mints liquidity to the maker, builds + ships a bidirectional FOT strategy, and returns
 * the order + strategy hash. The salt must be unique per shipped strategy.
 */
export async function setupStrategy(salt: bigint): Promise<StrategyFixture> {
  const { fot, regular, feeBps, feeFloor } = getContext().addresses
  const maker = accountAddress('maker')

  const program = buildBidirectionalProgram({
    fotToken: fot,
    feeBps: BigInt(feeBps),
    feeFloor,
    salt,
  })
  const order = makeOrder(maker, program)

  await mintTo(fot, maker, FOT_BALANCE)
  await mintTo(regular, maker, REGULAR_BALANCE)

  const strategyHash = await ship(order, fot, regular, FOT_BALANCE, REGULAR_BALANCE)

  return { order, strategyHash, fot, regular }
}
