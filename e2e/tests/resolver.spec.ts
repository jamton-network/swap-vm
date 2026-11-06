import { getContext } from '../src/context'
import {
  FOT_BALANCE,
  REGULAR_BALANCE,
  accountAddress,
  aquaSafeBalances,
  asAddress,
  ceilDiv,
  grossUp,
  mintTo,
  quote,
  resolverTakerTraits,
  setupStrategy,
  swapResolver,
  tokenBalance,
  transferFee,
  type StrategyFixture,
} from '../src/helpers'

const E18 = 10n ** 18n
const BPS = BigInt(getContext().addresses.feeBps)
const feeFloor = getContext().addresses.feeFloor
const FEE_DENOM = 1_000_000_000n

describe('resolver (one-hop)', () => {
  const resolver = asAddress(getContext().addresses.resolver)
  const treasury = asAddress(getContext().addresses.treasury)
  const maker = accountAddress('maker')

  async function fixture(salt: bigint): Promise<StrategyFixture> {
    return setupStrategy(salt)
  }

  it('FOT-in exact-in: quote == swap, maker no-drift', async () => {
    const { order, fot, regular, strategyHash } = await fixture(101n)
    const amount = 100n * E18

    const net = amount - transferFee(amount, BPS, feeFloor)
    const expectedOut = (net * REGULAR_BALANCE) / (FOT_BALANCE + net)

    await mintTo(fot, resolver, amount)

    const q = await quote(order, fot, regular, amount, resolverTakerTraits(true))
    expect(q.amountIn).toBe(amount) // gross
    expect(q.amountOut).toBe(expectedOut) // priced on net

    const makerFotBefore = await tokenBalance(fot, maker)
    const [virtualFotBefore] = await aquaSafeBalances(strategyHash, fot, regular)

    const s = await swapResolver(order, fot, regular, amount, resolverTakerTraits(true))
    expect(s.amountIn).toBe(q.amountIn)
    expect(s.amountOut).toBe(q.amountOut)

    const makerFotAfter = await tokenBalance(fot, maker)
    const [virtualFotAfter] = await aquaSafeBalances(strategyHash, fot, regular)

    expect(virtualFotAfter - virtualFotBefore).toBe(net)
    expect(makerFotAfter - makerFotBefore).toBe(net)
    expect(makerFotAfter - makerFotBefore).toBe(virtualFotAfter - virtualFotBefore) // no drift
  })

  it('FOT-in exact-out: quote == swap, taker pays gross', async () => {
    const { order, fot, regular } = await fixture(102n)
    const amountOut = 100n * E18

    const netIn = ceilDiv((amountOut * FOT_BALANCE), REGULAR_BALANCE - amountOut)
    const grossIn = netIn + grossUp(netIn, BPS)

    await mintTo(fot, resolver, grossIn)

    const q = await quote(order, fot, regular, amountOut, resolverTakerTraits(false))
    expect(q.amountOut).toBe(amountOut)
    expect(q.amountIn).toBe(grossIn)

    const s = await swapResolver(order, fot, regular, amountOut, resolverTakerTraits(false))
    expect(s.amountOut).toBe(q.amountOut)
    expect(s.amountIn).toBe(q.amountIn)
  })

  it('FOT-out exact-in: quote == swap, taker receives net', async () => {
    const { order, fot, regular } = await fixture(103n)
    const amount = 100n * E18 // regular in

    const gross = (amount * FOT_BALANCE) / (REGULAR_BALANCE + amount)
    const net = gross - transferFee(gross, BPS, feeFloor)

    await mintTo(regular, resolver, amount)

    const q = await quote(order, regular, fot, amount, resolverTakerTraits(true))
    expect(q.amountIn).toBe(amount)
    expect(q.amountOut).toBe(net)

    const takerFotBefore = await tokenBalance(fot, resolver)
    const treasuryFotBefore = await tokenBalance(fot, treasury)

    const s = await swapResolver(order, regular, fot, amount, resolverTakerTraits(true))
    expect(s.amountIn).toBe(q.amountIn)
    expect(s.amountOut).toBe(q.amountOut)

    expect((await tokenBalance(fot, resolver)) - takerFotBefore).toBe(net)
    expect((await tokenBalance(fot, treasury)) - treasuryFotBefore).toBe(gross - net)
  })

  it('FOT-out exact-out: quote == swap, taker receives net', async () => {
    const { order, fot, regular } = await fixture(104n)
    const amountOut = 90n * E18 // taker wants net FOT

    const grossOut = amountOut + grossUp(amountOut, BPS)
    const grossIn = ceilDiv((grossOut * REGULAR_BALANCE), FOT_BALANCE - grossOut)

    await mintTo(regular, resolver, grossIn)

    const q = await quote(order, regular, fot, amountOut, resolverTakerTraits(false))
    expect(q.amountOut).toBe(amountOut)
    expect(q.amountIn).toBe(grossIn)

    const takerFotBefore = await tokenBalance(fot, resolver)
    const treasuryFotBefore = await tokenBalance(fot, treasury)

    const s = await swapResolver(order, regular, fot, amountOut, resolverTakerTraits(false))
    expect(s.amountOut).toBe(q.amountOut)
    expect(s.amountIn).toBe(q.amountIn)

    expect((await tokenBalance(fot, resolver)) - takerFotBefore).toBe(amountOut)
    expect((await tokenBalance(fot, treasury)) - treasuryFotBefore).toBe(grossOut - amountOut)
  })
})
