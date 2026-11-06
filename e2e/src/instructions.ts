import { Address, HexString } from '@1inch/sdk-core'
import { ProgramBuilder, SwapVmProgram, instructions } from '@1inch/swap-vm-sdk'
import { bytesToHex, hexToBytes } from 'viem'

/**
 * Args for the FeeOnTransferIn / FeeOnTransferOut instructions.
 *
 * Wire encoding (mirrors FeeOnTransferArgsBuilder in src/instructions/FeeOnTransfer.sol):
 *   [uint32 feeBps][uint8 feeFloor]
 *
 * - `feeBps` is the transfer tax in bps, `1e9 = 100%`.
 * - `feeFloor=false` rounds the fee up (net down, maker-safe default); `true` rounds down.
 */
export class FeeOnTransferArgs implements instructions.IArgsData {
  static readonly CODER: instructions.IArgsCoder<FeeOnTransferArgs> = {
    encode(args) {
      const bytes = new Uint8Array(5)
      let bps = args.feeBps
      bytes[3] = Number(bps & 0xffn)
      bps >>= 8n
      bytes[2] = Number(bps & 0xffn)
      bps >>= 8n
      bytes[1] = Number(bps & 0xffn)
      bps >>= 8n
      bytes[0] = Number(bps & 0xffn)
      bytes[4] = args.feeFloor ? 1 : 0
      return new HexString(bytesToHex(bytes))
    },
    decode(data) {
      const bytes = hexToBytes(data.toString() as `0x${string}`)
      const feeBps = (BigInt(bytes[0]) << 24n) | (BigInt(bytes[1]) << 16n) | (BigInt(bytes[2]) << 8n) | BigInt(bytes[3])
      const feeFloor = bytes[4] !== 0
      return new FeeOnTransferArgs(feeBps, feeFloor)
    },
  }

  constructor(
    readonly feeBps: bigint,
    readonly feeFloor: boolean,
  ) {}

  toJSON() {
    return { feeBps: this.feeBps.toString(), feeFloor: this.feeFloor }
  }
}

type IOpcode<T extends instructions.IArgsData = instructions.IArgsData> = instructions.IOpcode<T>

function makeOpcode<T extends instructions.IArgsData>(name: string, coder: instructions.IArgsCoder<T>): IOpcode<T> {
  const opcode: IOpcode<T> = {
    id: Symbol(name),
    argsCoder: () => coder,
    createIx: (args: T) => ({ opcode, args, toJSON: () => args.toJSON() ?? {} }),
  }
  return opcode
}

export const feeOnTransferInXD = makeOpcode('FeeOnTransfer.feeOnTransferInXD', FeeOnTransferArgs.CODER)
export const feeOnTransferOutXD = makeOpcode('FeeOnTransfer.feeOnTransferOutXD', FeeOnTransferArgs.CODER)

/**
 * Wire opcode bytes for the two FOT instructions.
 *
 * `AquaOpcodes.sol` places these at declared array indices 23/24, but `_opcodes()`'s
 * static->dynamic array trick rewrites element 0 with the array length, shifting every
 * runtime index down by one. The live probe in `tests/00-alignment.spec.ts` confirms the
 * true wire bytes are 22 (FOT-in) and 23 (FOT-out): emitting 23 for FOT-in executes
 * `FeeOnTransferOut` instead (the output is taxed rather than the input).
 */
export const FOT_IN_SLOT = 22
export const FOT_OUT_SLOT = 23

/**
 * The Aqua opcode table extended with the two FOT instructions in the reserved slots.
 * `ProgramBuilder.build()` maps an opcode's `id` to its index in this array, so
 * replacing the reserved slots is enough to emit the FOT wire bytes.
 */
export const fotAquaInstructions: IOpcode[] = [...instructions.aquaInstructions]
fotAquaInstructions[FOT_IN_SLOT] = feeOnTransferInXD
fotAquaInstructions[FOT_OUT_SLOT] = feeOnTransferOutXD

/**
 * Byte offsets into the bidirectional program (see test/FeeOnTransfer.t.sol
 * `_programBidirectional`). These are size-derived, so they hold regardless of
 * the concrete opcode bytes:
 *   jumpIfTokenIn (24B) | FeeOnTransferOut (7B) | jump (4B) | FeeOnTransferIn (7B) | XYCSwap (2B)
 */
export const FOT_IN_OFFSET = 35
export const COMMON_OFFSET = 42

export interface BidirectionalProgramArgs {
  /** The fee-on-transfer token (tokenA in the program). */
  fotToken: string
  feeBps: bigint
  feeFloor: boolean
  salt: bigint
}

/**
 * A single bidirectional strategy: FOT-in when `fotToken` is the input, FOT-out
 * otherwise, then a constant-product XYCSwap. Mirrors `_programBidirectional`.
 */
export function buildBidirectionalProgram(args: BidirectionalProgramArgs): SwapVmProgram {
  const builder = new ProgramBuilder(fotAquaInstructions)

  const jumpIfTokenIn = instructions.controls.jumpIfTokenIn
  const jump = instructions.controls.jump
  const xycSwapXD = instructions.xycSwap.xycSwapXD
  const salt = instructions.controls.salt

  builder.add(
    jumpIfTokenIn.createIx(new instructions.controls.JumpIfTokenArgs(new Address(args.fotToken), BigInt(FOT_IN_OFFSET))),
  )
  builder.add(feeOnTransferOutXD.createIx(new FeeOnTransferArgs(args.feeBps, args.feeFloor)))
  builder.add(jump.createIx(new instructions.controls.JumpArgs(BigInt(COMMON_OFFSET))))
  builder.add(feeOnTransferInXD.createIx(new FeeOnTransferArgs(args.feeBps, args.feeFloor)))
  builder.add(xycSwapXD.createIx(new instructions.xycSwap.XycSwapXDArgs()))
  builder.add(salt.createIx(instructions.controls.SaltArgs.fromUint64(args.salt)))

  return builder.build()
}
