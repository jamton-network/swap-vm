import { getContext } from '../src/context'
import { buildBidirectionalProgram } from '../src/instructions'
import {
  FOT_BALANCE,
  REGULAR_BALANCE,
  accountAddress,
  aquaRawBalances,
  aquaSafeBalances,
  dock,
  expectRevert,
  makeOrder,
  mintTo,
  quote,
  resolverTakerTraits,
  setupStrategy,
  ship,
  swapResolver,
  tokenBalance,
} from '../src/helpers'

describe('ship/dock liquidity lifecycle', () => {
  const maker = accountAddress('maker')

  it('ship records virtual balances without moving tokens', async () => {
    const { fot, regular, feeBps, feeFloor } = getContext().addresses
    const program = buildBidirectionalProgram({ fotToken: fot, feeBps: BigInt(feeBps), feeFloor, salt: 301n })
    const order = makeOrder(maker, program)

    await mintTo(fot, maker, FOT_BALANCE)
    await mintTo(regular, maker, REGULAR_BALANCE)

    const fotBefore = await tokenBalance(fot, maker)
    const regularBefore = await tokenBalance(regular, maker)

    const strategyHash = await ship(order, fot, regular, FOT_BALANCE, REGULAR_BALANCE)

    expect(await tokenBalance(fot, maker)).toBe(fotBefore) // ship moved no tokens
    expect(await tokenBalance(regular, maker)).toBe(regularBefore)

    const [fotBal, regularBal] = await aquaSafeBalances(strategyHash, fot, regular)
    expect(fotBal).toBe(FOT_BALANCE)
    expect(regularBal).toBe(REGULAR_BALANCE)

    const [, fotTokensCount] = await aquaRawBalances(strategyHash, fot)
    expect(fotTokensCount).toBe(2)
  })

  it('dock closes the strategy', async () => {
    const { strategyHash, fot, regular } = await setupStrategy(302n)

    await dock(strategyHash, [fot, regular])

    const [fotBal, fotCount] = await aquaRawBalances(strategyHash, fot)
    expect(fotBal).toBe(0n)
    expect(fotCount).toBe(255)

    const [regularBal, regularCount] = await aquaRawBalances(strategyHash, regular)
    expect(regularBal).toBe(0n)
    expect(regularCount).toBe(255)

    await expectRevert(aquaSafeBalances(strategyHash, fot, regular))
  })

  it('quote and swap revert after dock', async () => {
    const { order, strategyHash, fot, regular } = await setupStrategy(303n)
    const amount = 100n * 10n ** 18n

    await dock(strategyHash, [fot, regular])

    await expectRevert(quote(order, fot, regular, amount, resolverTakerTraits(true)))
    await expectRevert(swapResolver(order, fot, regular, amount, resolverTakerTraits(true)))
  })
})
