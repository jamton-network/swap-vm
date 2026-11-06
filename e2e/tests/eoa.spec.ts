import { getContext } from '../src/context'
import {
  FOT_BALANCE,
  REGULAR_BALANCE,
  accountAddress,
  aquaSafeBalances,
  asAddress,
  ceilDiv,
  doubleFee,
  eoaTakerTraits,
  grossUp,
  mintTo,
  quote,
  setupStrategy,
  swapEoa,
  tokenBalance,
  transferFee,
  type StrategyFixture,
} from '../src/helpers'

const E18 = 10n ** 18n
const BPS = BigInt(getContext().addresses.feeBps)
const feeFloor = getContext().addresses.feeFloor

describe('EOA (two-hop)', () => {
  const eoa = accountAddress('eoa')
  const treasury = asAddress(getContext().addresses.treasury)
  const maker = accountAddress('maker')

  async function fixture(salt: bigint): Promise<StrategyFixture> {
    return setupStrategy(salt)
  }

  it('FOT-in exact-in: double-tax net, quote == swap, maker no-drift', async () => {
    const { order, fot, regular, strategyHash } = await fixture(201n)
    const amount = 100n * E18

    const net = amount - doubleFee(amount, BPS, feeFloor)
    const expectedOut = (net * REGULAR_BALANCE) / (FOT_BALANCE + net)

    await mintTo(fot, eoa, amount)

    const q = await quote(order, fot, regular, amount, eoaTakerTraits(true))
    expect(q.amountIn).toBe(amount) // gross
    expect(q.amountOut).toBe(expectedOut) // priced on double-tax net

    const makerFotBefore = await tokenBalance(fot, maker)
    const [virtualFotBefore] = await aquaSafeBalances(strategyHash, fot, regular)

    const s = await swapEoa(order, fot, regular, amount, eoaTakerTraits(true))
    expect(s.amountIn).toBe(q.amountIn)
    expect(s.amountOut).toBe(q.amountOut)

    const makerFotAfter = await tokenBalance(fot, maker)
    const [virtualFotAfter] = await aquaSafeBalances(strategyHash, fot, regular)

    expect(virtualFotAfter - virtualFotBefore).toBe(net)
    expect(makerFotAfter - makerFotBefore).toBe(net)
    expect(makerFotAfter - makerFotBefore).toBe(virtualFotAfter - virtualFotBefore) // no drift
  })

  it('FOT-in exact-out: quote == swap, EOA pays double gross', async () => {
    const { order, fot, regular } = await fixture(202n)
    const amountOut = 100n * E18

    const netIn = ceilDiv((amountOut * FOT_BALANCE), REGULAR_BALANCE - amountOut)
    let gross = netIn
    gross += grossUp(gross, BPS)
    gross += grossUp(gross, BPS)

    await mintTo(fot, eoa, gross)

    const q = await quote(order, fot, regular, amountOut, eoaTakerTraits(false))
    expect(q.amountOut).toBe(amountOut)
    expect(q.amountIn).toBe(gross)

    const s = await swapEoa(order, fot, regular, amountOut, eoaTakerTraits(false))
    expect(s.amountOut).toBe(q.amountOut)
    expect(s.amountIn).toBe(q.amountIn)
  })

  it('FOT-out exact-in: quote == swap, EOA receives net', async () => {
    const { order, fot, regular } = await fixture(203n)
    const amount = 100n * E18 // regular in

    const gross = (amount * FOT_BALANCE) / (REGULAR_BALANCE + amount)
    const net = gross - transferFee(gross, BPS, feeFloor)

    await mintTo(regular, eoa, amount)

    const q = await quote(order, regular, fot, amount, eoaTakerTraits(true))
    expect(q.amountIn).toBe(amount)
    expect(q.amountOut).toBe(net)

    const takerFotBefore = await tokenBalance(fot, eoa)
    const treasuryFotBefore = await tokenBalance(fot, treasury)

    const s = await swapEoa(order, regular, fot, amount, eoaTakerTraits(true))
    expect(s.amountIn).toBe(q.amountIn)
    expect(s.amountOut).toBe(q.amountOut)

    expect((await tokenBalance(fot, eoa)) - takerFotBefore).toBe(net)
    expect((await tokenBalance(fot, treasury)) - treasuryFotBefore).toBe(gross - net)
  })

  it('FOT-out exact-out: quote == swap, EOA receives net', async () => {
    const { order, fot, regular } = await fixture(204n)
    const amountOut = 90n * E18

    const grossOut = amountOut + grossUp(amountOut, BPS)
    const grossIn = ceilDiv((grossOut * REGULAR_BALANCE), FOT_BALANCE - grossOut)

    await mintTo(regular, eoa, grossIn)

    const q = await quote(order, regular, fot, amountOut, eoaTakerTraits(false))
    expect(q.amountOut).toBe(amountOut)
    expect(q.amountIn).toBe(grossIn)

    const takerFotBefore = await tokenBalance(fot, eoa)
    const treasuryFotBefore = await tokenBalance(fot, treasury)

    const s = await swapEoa(order, regular, fot, amountOut, eoaTakerTraits(false))
    expect(s.amountOut).toBe(q.amountOut)
    expect(s.amountIn).toBe(q.amountIn)

    expect((await tokenBalance(fot, eoa)) - takerFotBefore).toBe(amountOut)
    expect((await tokenBalance(fot, treasury)) - treasuryFotBefore).toBe(grossOut - amountOut)
  })
})
