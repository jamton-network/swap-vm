// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright © 2025 Degensoft Ltd

import { Script } from "forge-std/Script.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { TokenMock } from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";

import { AquaSwapVMRouter } from "../src/routers/AquaSwapVMRouter.sol";
import { FeeOnTransferTokenMock } from "../test/mocks/FeeOnTransferTokenMock.sol";
import { MockTaker } from "../test/mocks/MockTaker.sol";

// solhint-disable no-console
import { console2 } from "forge-std/console2.sol";

/// @notice Deploys the E2E fixture for fee-on-transfer tests and persists the addresses.
///   Run against a local anvil: `forge script script/DeployE2e.s.sol --broadcast --rpc-url http://127.0.0.1:8545`.
contract DeployE2e is Script {
    uint32 constant FEE_BPS = 1e8; // 10%
    bool constant FEE_FLOOR = false; // ceil fee (net down)

    function run() external {
        address owner = msg.sender;
        address treasury = vm.addr(uint256(keccak256("e2e-treasury")));

        vm.startBroadcast();
        Aqua aqua = new Aqua();
        AquaSwapVMRouter router = new AquaSwapVMRouter(address(aqua), address(0), owner, "SwapVM", "1.0.0");
        FeeOnTransferTokenMock fot = new FeeOnTransferTokenMock("Fee On Transfer", "FOT", FEE_BPS, treasury, FEE_FLOOR);
        TokenMock regular = new TokenMock("Regular", "REG");
        MockTaker resolver = new MockTaker(aqua, router, owner);
        vm.stopBroadcast();

        vm.createDir("deployments", true);
        string memory obj = "e2e";
        vm.serializeAddress(obj, "aqua", address(aqua));
        vm.serializeAddress(obj, "router", address(router));
        vm.serializeAddress(obj, "fot", address(fot));
        vm.serializeAddress(obj, "regular", address(regular));
        vm.serializeAddress(obj, "resolver", address(resolver));
        vm.serializeAddress(obj, "treasury", treasury);
        vm.serializeAddress(obj, "owner", owner);
        vm.serializeString(obj, "feeBps", vm.toString(FEE_BPS));
        vm.serializeBool(obj, "feeFloor", FEE_FLOOR);
        string memory json = vm.serializeString(obj, "chainId", vm.toString(block.chainid));
        vm.writeJson(json, "./deployments/e2e.json");

        console2.log("Aqua:", address(aqua));
        console2.log("Router:", address(router));
        console2.log("FOT:", address(fot));
        console2.log("Regular:", address(regular));
        console2.log("Resolver (MockTaker):", address(resolver));
        console2.log("Treasury:", treasury);
    }
}
// solhint-enable no-console
