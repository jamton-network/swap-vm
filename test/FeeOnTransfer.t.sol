// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright © 2025 Degensoft Ltd

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { AquaSwapVMTest } from "./base/AquaSwapVMTest.sol";

import { ISwapVM } from "../src/interfaces/ISwapVM.sol";
import { SwapVM } from "../src/SwapVM.sol";
import { TakerTraitsLib } from "../src/libs/TakerTraits.sol";

import { XYCSwap } from "../src/instructions/XYCSwap.sol";
import { Controls, ControlsArgsBuilder } from "../src/instructions/Controls.sol";
import { FeeOnTransfer, FeeOnTransferArgsBuilder } from "../src/instructions/FeeOnTransfer.sol";

import { Program, ProgramBuilder } from "./utils/ProgramBuilder.sol";

import { FeeOnTransferTokenMock } from "./mocks/FeeOnTransferTokenMock.sol";

contract FeeOnTransferTest is AquaSwapVMTest {
    using ProgramBuilder for Program;

    uint32 constant FEE_BPS = 1e8; // 10%
    uint256 constant FEE_DENOM = 1e9;

    uint256 constant FOT_BALANCE = 1000e18; // tokenA balance
    uint256 constant REGULAR_BALANCE = 2000e18; // tokenB balance

    address public treasury;

    function setUp() public override {
        super.setUp();
        treasury = vm.addr(0x9999);
        // tokenA becomes the fee-on-transfer token
        tokenA = new FeeOnTransferTokenMock("Token A", "TKA", FEE_BPS, treasury, false);
    }

    function _program(bool fotIn, bool fotOut, bool feeFloor) internal view returns (bytes memory) {
        Program memory p = ProgramBuilder.init(_opcodes());
        return bytes.concat(
            fotIn ? p.build(FeeOnTransfer._feeOnTransferInXD, FeeOnTransferArgsBuilder.build(FEE_BPS, feeFloor)) : bytes(""),
            fotOut ? p.build(FeeOnTransfer._feeOnTransferOutXD, FeeOnTransferArgsBuilder.build(FEE_BPS, feeFloor)) : bytes(""),
            p.build(XYCSwap._xycSwapXD),
            p.build(Controls._salt, abi.encodePacked(vm.randomUint()))
        );
    }

    /// @dev A single strategy that branches on direction: FOT-in if tokenA is the input,
    ///   FOT-out otherwise (tokenA is the output). Layout with byte offsets:
    ///   jumpIfTokenIn(tokenA, 35)   [0..24)
    ///   FeeOnTransferOut            [24..31)
    ///   Jump(42)                    [31..35)
    ///   FeeOnTransferIn             [35..42)
    ///   XYCSwap                     [42..44)
    function _programBidirectional(bool feeFloor) internal view returns (bytes memory) {
        Program memory p = ProgramBuilder.init(_opcodes());
        uint16 fotIn = 35;
        uint16 common = 42;
        return bytes.concat(
            p.build(Controls._jumpIfTokenIn, ControlsArgsBuilder.buildJumpIfToken(address(tokenA), fotIn)),
            p.build(FeeOnTransfer._feeOnTransferOutXD, FeeOnTransferArgsBuilder.build(FEE_BPS, feeFloor)),
            p.build(Controls._jump, ControlsArgsBuilder.buildJump(common)),
            p.build(FeeOnTransfer._feeOnTransferInXD, FeeOnTransferArgsBuilder.build(FEE_BPS, feeFloor)),
            p.build(XYCSwap._xycSwapXD),
            p.build(Controls._salt, abi.encodePacked(vm.randomUint()))
        );
    }

    function _ship(ISwapVM.Order memory order) internal returns (bytes32) {
        return shipStrategy(order, tokenA, tokenB, FOT_BALANCE, REGULAR_BALANCE);
    }

    function _mintLiquidity() internal {
        tokenA.mint(maker, FOT_BALANCE);
        tokenB.mint(maker, REGULAR_BALANCE);
    }

    function _programSwap(uint256 amount, bool zeroForOne, bool isExactIn) internal view returns (SwapProgram memory) {
        return SwapProgram({
            amount: amount,
            taker: taker,
            tokenA: tokenA,
            tokenB: tokenB,
            zeroForOne: zeroForOne,
            isExactIn: isExactIn
        });
    }

    function _takerDataWithPush(bool isExactIn) internal view returns (bytes memory) {
        return TakerTraitsLib.build(TakerTraitsLib.Args({
            taker: address(taker),
            isExactIn: isExactIn,
            shouldUnwrapWeth: false,
            hasPreTransferInCallback: true,
            hasPreTransferOutCallback: false,
            isStrictThresholdAmount: false,
            isFirstTransferFromTaker: false,
            useTransferFromAndAquaPush: true,
            threshold: "",
            to: address(0),
            deadline: 0,
            preTransferInHookData: "",
            postTransferInHookData: "",
            preTransferOutHookData: "",
            postTransferOutHookData: "",
            preTransferInCallbackData: "",
            preTransferOutCallbackData: "",
            instructionsArgs: "",
            signature: ""
        }));
    }

    // ============================================================
    // FOT tokenIn (tokenA -> tokenB, balanceIn = FOT_BALANCE)
    // ============================================================

    function test_FOT_In_ExactIn_NoDrift() public {
        uint256 amount = 100e18;

        ISwapVM.Order memory order = createStrategy(_program(true, false, false));
        bytes32 strategyHash = _ship(order);

        _mintLiquidity();
        tokenA.mint(address(taker), amount);

        SwapProgram memory sp = _programSwap(amount, true, true);

        (uint256 amountIn, uint256 amountOut) = quote(sp, order);

        uint256 net = amount - Math.ceilDiv(amount * FEE_BPS, FEE_DENOM); // 90e18
        uint256 expectedOut = net * REGULAR_BALANCE / (FOT_BALANCE + net);

        assertEq(amountIn, amount, "amountIn stays gross");
        assertEq(amountOut, expectedOut, "amountOut priced on net");

        swap(sp, order);

        (uint256 virtualA,) = getAquaBalances(strategyHash);
        uint256 walletA = tokenA.balanceOf(maker);

        assertEq(virtualA, FOT_BALANCE + net, "virtual FOT grows by net");
        assertEq(walletA, virtualA, "no drift: wallet FOT == virtual FOT");
    }

    function test_FOT_In_ExactOut() public {
        uint256 amountOut = 100e18;

        ISwapVM.Order memory order = createStrategy(_program(true, false, false));
        _ship(order);

        _mintLiquidity();

        uint256 netIn = Math.ceilDiv(amountOut * FOT_BALANCE, REGULAR_BALANCE - amountOut);
        uint256 grossIn = netIn + Math.ceilDiv(netIn * FEE_BPS, FEE_DENOM - FEE_BPS);
        tokenA.mint(address(taker), grossIn);

        SwapProgram memory sp = _programSwap(amountOut, true, false);
        (uint256 amountIn, uint256 amountOutReturned) = swap(sp, order);

        assertEq(amountOutReturned, amountOut, "amountOut == taker specified");
        assertEq(amountIn, grossIn, "taker pays gross amountIn");
    }

    // ============================================================
    // FOT tokenOut (tokenB -> tokenA, balanceOut = FOT_BALANCE)
    // ============================================================

    function test_FOT_Out_ExactIn_TakerReceivesNet() public {
        uint256 amount = 100e18;

        ISwapVM.Order memory order = createStrategy(_program(false, true, false));
        _ship(order);

        _mintLiquidity();
        tokenB.mint(address(taker), amount);

        SwapProgram memory sp = _programSwap(amount, false, true);
        (uint256 amountIn, uint256 amountOut) = swap(sp, order);

        uint256 gross = amount * FOT_BALANCE / (REGULAR_BALANCE + amount);
        uint256 net = gross - Math.ceilDiv(gross * FEE_BPS, FEE_DENOM);

        assertEq(amountIn, amount, "amountIn unchanged");
        assertEq(amountOut, net, "quote reports the net the taker receives");

        assertEq(tokenA.balanceOf(address(taker)), net, "taker receives net tokenOut");
        assertEq(tokenA.balanceOf(treasury), gross - net, "treasury receives the fee");
    }

    function test_FOT_Out_ExactOut_TakerReceivesNet() public {
        uint256 amountOut = 90e18; // taker wants 90e18 FOT net

        ISwapVM.Order memory order = createStrategy(_program(false, true, false));
        _ship(order);

        _mintLiquidity();

        uint256 grossOut = amountOut + Math.ceilDiv(amountOut * FEE_BPS, FEE_DENOM - FEE_BPS);
        uint256 grossIn = Math.ceilDiv(grossOut * REGULAR_BALANCE, FOT_BALANCE - grossOut);
        tokenB.mint(address(taker), grossIn);

        SwapProgram memory sp = _programSwap(amountOut, false, false);
        (uint256 amountIn, uint256 amountOutReturned) = swap(sp, order);

        assertEq(amountOutReturned, amountOut, "amountOut == taker specified net");
        assertEq(amountIn, grossIn, "maker priced on the gross output");

        assertEq(tokenA.balanceOf(address(taker)), amountOut, "taker receives net tokenOut");
        assertEq(tokenA.balanceOf(treasury), grossOut - amountOut, "treasury receives the fee");
    }

    // ============================================================
    // Single bidirectional strategy (Controls jumps)
    // ============================================================

    function test_FOT_SingleStrategy_BothDirections() public {
        ISwapVM.Order memory order = createStrategy(_programBidirectional(false));
        bytes32 strategyHash = _ship(order);

        _mintLiquidity();

        // ---- FOT-in: tokenA (FOT) -> tokenB ----
        uint256 amountIn = 100e18;
        tokenA.mint(address(taker), amountIn);
        (uint256 grossIn, ) = swap(_programSwap(amountIn, true, true), order);

        uint256 netIn = amountIn - Math.ceilDiv(amountIn * FEE_BPS, FEE_DENOM);
        assertEq(grossIn, amountIn, "FOT-in register amountIn is gross");

        (uint256 virtualA,) = getAquaBalances(strategyHash);
        assertEq(virtualA, FOT_BALANCE + netIn, "FOT-in credits net FOT");
        assertEq(tokenA.balanceOf(maker), virtualA, "no drift after FOT-in");

        // ---- FOT-out: tokenB -> tokenA (FOT), same strategy ----
        (uint256 balA, uint256 balB) = getAquaBalances(strategyHash); // reserves after FOT-in
        uint256 treasuryBefore = tokenA.balanceOf(treasury);

        uint256 amountInB = 100e18;
        tokenB.mint(address(taker), amountInB);
        (uint256 retInB, uint256 amountOutNet) = swap(_programSwap(amountInB, false, true), order);

        uint256 grossOut = amountInB * balA / (balB + amountInB);
        uint256 expectedNet = grossOut - Math.ceilDiv(grossOut * FEE_BPS, FEE_DENOM);

        assertEq(retInB, amountInB, "FOT-out amountIn unchanged");
        assertEq(amountOutNet, expectedNet, "FOT-out quote reports net");
        assertEq(tokenA.balanceOf(address(taker)), expectedNet, "taker receives net FOT");
        assertEq(tokenA.balanceOf(treasury) - treasuryBefore, grossOut - expectedNet, "treasury receives FOT-out fee");
    }

    // ============================================================
    // Two-hop guard
    // ============================================================

    function test_FOT_In_TwoHop_Reverts() public {
        ISwapVM.Order memory order = createStrategy(_program(true, false, false));
        _ship(order);

        tokenA.mint(address(taker), 100e18);

        vm.expectRevert(SwapVM.FeeOnTransferTwoHopUnsupported.selector);
        swapVM.swap(order, address(tokenA), address(tokenB), 100e18, _takerDataWithPush(true));
    }

    // ============================================================
    // Rounding flag
    // ============================================================

    function test_FOT_In_ExactIn_FloorRounding() public {
        // Redeploy tokenA with floor rounding to match the floor flag
        tokenA = new FeeOnTransferTokenMock("Token A", "TKA", FEE_BPS, treasury, true);

        uint256 amount = 101e18; // floor(10.1e18) fee == 10e18

        ISwapVM.Order memory order = createStrategy(_program(true, false, true));
        bytes32 strategyHash = _ship(order);

        _mintLiquidity();
        tokenA.mint(address(taker), amount);

        swap(_programSwap(amount, true, true), order);

        uint256 net = amount - amount * FEE_BPS / FEE_DENOM; // floor fee
        (uint256 virtualA,) = getAquaBalances(strategyHash);
        assertEq(virtualA, FOT_BALANCE + net, "floor fee credited as net");
        assertEq(tokenA.balanceOf(maker), virtualA, "no drift with floor rounding");
    }
}
