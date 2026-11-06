// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright © 2025 Degensoft Ltd

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Calldata } from "@1inch/solidity-utils/contracts/libraries/Calldata.sol";
import { Context, ContextLib } from "../libs/VM.sol";

uint256 constant FOT_BPS = 1e9;

library FeeOnTransferArgsBuilder {
    using Calldata for bytes;

    error FeeOnTransferBpsOutOfRange(uint32 feeBps);
    error FeeOnTransferMissingFeeBps();
    error FeeOnTransferMissingRounding();

    function build(uint32 feeBps, bool feeFloor) internal pure returns (bytes memory) {
        require(feeBps < FOT_BPS, FeeOnTransferBpsOutOfRange(feeBps));
        return abi.encodePacked(feeBps, feeFloor ? uint8(1) : uint8(0));
    }

    function parse(bytes calldata args) internal pure returns (uint32 feeBps, bool feeFloor) {
        feeBps = uint32(bytes4(args.slice(0, 4, FeeOnTransferMissingFeeBps.selector)));
        feeFloor = uint8(args.slice(4, 5, FeeOnTransferMissingRounding.selector)[0]) != 0;
    }
}

/// @title FeeOnTransfer
/// @notice Instructions for tokens that take a fixed percent fee on transfer/transferFrom.
///   The taker always absorbs the tax: the pricing loop sees the net amount, while the
///   settlement registers carry the gross amount actually transferred.
/// @dev Both settlement paths are supported: one-hop (single tax) and two-hop
///   (useTransferFromAndAquaPush, double tax). The input-side instruction detects the
///   hop count via `ctx.settlement.twoHop`.
contract FeeOnTransfer {
    using Calldata for bytes;
    using ContextLib for Context;

    error FeeOnTransferShouldBeAppliedBeforeSwapAmountsComputation();

    /// @notice Fee-on-transfer on tokenIn: the taker sends gross, the maker receives net.
    /// @dev Encoding: [uint32 feeBps, uint8 feeFloor]
    ///   feeBps is the transfer tax in bps (1e9 = 100%). feeFloor selects the fee rounding:
    ///   false rounds the fee up (net down, maker-safe default), true rounds the fee down.
    /// @dev The tax is applied once for the one-hop path and twice for the two-hop path
    ///   (useTransferFromAndAquaPush), detected via `ctx.settlement.twoHop`.
    /// @param args.feeBps   | 4 bytes
    /// @param args.feeFloor | 1 byte (0 = ceil fee, 1 = floor fee)
    function _feeOnTransferInXD(Context memory ctx, bytes calldata args) internal {
        (uint32 feeBps, bool feeFloor) = FeeOnTransferArgsBuilder.parse(args);
        require(ctx.swap.amountIn == 0 || ctx.swap.amountOut == 0, FeeOnTransferShouldBeAppliedBeforeSwapAmountsComputation());

        bool twoHop = ctx.settlement.twoHop;

        if (ctx.query.isExactIn) {
            uint256 fee = twoHop ? _feeDouble(ctx.swap.amountIn, feeBps, feeFloor) : _fee(ctx.swap.amountIn, feeBps, feeFloor);
            ctx.swap.amountIn -= fee; // net

            uint256 reduction = ctx.swap.amountIn;
            ctx.runLoop();
            reduction -= ctx.swap.amountIn;

            uint256 added;
            if (reduction == 0) {
                added = fee; // restore the taker-specified gross amount
            } else {
                added = twoHop ? _grossUpDouble(ctx.swap.amountIn, feeBps) : _grossUp(ctx.swap.amountIn, feeBps); // inner loop rewrote amountIn (drain)
            }
            ctx.swap.amountIn += added;
            ctx.settlement.amountInDelta = -int256(added);
        } else {
            ctx.runLoop(); // amountIn = net
            uint256 added = twoHop ? _grossUpDouble(ctx.swap.amountIn, feeBps) : _grossUp(ctx.swap.amountIn, feeBps);
            ctx.swap.amountIn += added; // gross
            ctx.settlement.amountInDelta = -int256(added);
        }
    }

    /// @notice Fee-on-transfer on tokenOut: the maker sends gross, the taker receives net.
    /// @dev Encoding: [uint32 feeBps, uint8 feeFloor]
    ///   feeBps is the transfer tax in bps (1e9 = 100%). feeFloor selects the fee rounding:
    ///   false rounds the fee up (net down, maker-safe default), true rounds the fee down.
    /// @param args.feeBps   | 4 bytes
    /// @param args.feeFloor | 1 byte (0 = ceil fee, 1 = floor fee)
    function _feeOnTransferOutXD(Context memory ctx, bytes calldata args) internal {
        (uint32 feeBps, bool feeFloor) = FeeOnTransferArgsBuilder.parse(args);
        require(ctx.swap.amountIn == 0 || ctx.swap.amountOut == 0, FeeOnTransferShouldBeAppliedBeforeSwapAmountsComputation());

        if (ctx.query.isExactIn) {
            ctx.runLoop(); // amountOut = gross
            uint256 gross = ctx.swap.amountOut;
            uint256 fee = _fee(gross, feeBps, feeFloor);
            ctx.swap.amountOut = gross - fee; // net (what the taker receives)
            ctx.settlement.amountOutDelta = int256(fee);
        } else {
            uint256 net = ctx.swap.amountOut; // taker-specified net
            uint256 added = _grossUp(net, feeBps);
            ctx.swap.amountOut = net + added; // gross (what the maker sends)
            ctx.runLoop();
            ctx.swap.amountOut = net; // restore the taker-specified net
            ctx.settlement.amountOutDelta = int256(added);
        }
    }

    /// @dev Fee on the transferred amount, rounded to match the token contract.
    function _fee(uint256 amount, uint256 feeBps, bool feeFloor) private pure returns (uint256) {
        return feeFloor ? amount * feeBps / FOT_BPS : Math.ceilDiv(amount * feeBps, FOT_BPS);
    }

    /// @dev Total fee over two sequential taxable transfers (taker -> router -> maker).
    function _feeDouble(uint256 amount, uint256 feeBps, bool feeFloor) private pure returns (uint256) {
        uint256 fee1 = _fee(amount, feeBps, feeFloor);
        return fee1 + _fee(amount - fee1, feeBps, feeFloor);
    }

    /// @dev Inverse of the fee: minimal gross such that `gross - _fee(gross) >= net`.
    ///   Always rounds the gross up, so the settlement never under-delivers.
    function _grossUp(uint256 net, uint256 feeBps) private pure returns (uint256) {
        return Math.ceilDiv(net * feeBps, FOT_BPS - feeBps);
    }

    /// @dev Inverse of the double fee: minimal extra amount such that the maker receives at
    ///   least `net` after two sequential taxable transfers. Applies the single-hop gross-up
    ///   twice, which is conservative (never under-delivers).
    function _grossUpDouble(uint256 net, uint256 feeBps) private pure returns (uint256) {
        uint256 gross = net;
        gross += _grossUp(gross, feeBps);
        gross += _grossUp(gross, feeBps);
        return gross - net;
    }
}
